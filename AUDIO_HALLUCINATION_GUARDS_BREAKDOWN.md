# Full Breakdown: Anti-Hallucination & Audio Pipeline (RSE Receptionist)

This document describes everything currently implemented to prevent hallucinated or mismatched audio in the receptionist system, based on `src/server-rse.js` (canonical server).

---

## 1. Audio Pipeline Architecture

### How audio chunks are received from OpenAI

- **Source:** OpenAI Realtime API sends WebSocket events.
- **Event:** `response.audio.delta` carries base64-encoded PCM audio in `event.delta`.
- **Decoding:** Chunks are decoded and appended to a single in-memory buffer:

```516:528:src/server-rse.js
      case "response.audio.delta":
        if (event.delta) {
          // Stop backchannel if it was playing
          if (backchannel.isPlaying()) {
            backchannel.stop();
            playBuffer = Buffer.alloc(0); // Clear backchannel audio
          }
          
          audioStreamingStarted = true;
          const audioData = Buffer.from(event.delta, "base64");
          playBuffer = Buffer.concat([playBuffer, audioData]);
          totalAudioBytesSent += audioData.length;  // Track total
          lastAudioDeltaTime = Date.now();  // Update last audio delta time
```

- **Note:** Audio deltas do **not** include a `response_id` in the event. All deltas for the call are appended to the same `playBuffer`.

### How they are buffered

- **Single buffer:** One `playBuffer` (Node `Buffer`) per call; starts as `Buffer.alloc(0)`.
- **Append-only from OpenAI:** New response audio is **appended** to existing buffer (no per-response buffer).
- **Consumption:** A 20ms-interval timer (`pumpFrames` / `setInterval`) reads from `playBuffer` in 160-byte frames (20ms of 8 kHz μ-law) and sends to Twilio.

```256:270:src/server-rse.js
      let frame;
      if (playBuffer.length >= FRAME_SIZE) {
        // Send audio from buffer
        frame = playBuffer.slice(0, FRAME_SIZE);
        playBuffer = playBuffer.slice(FRAME_SIZE);
      } else if (playBuffer.length > 0) {
        // Send partial frame padded with silence
        frame = Buffer.concat([
          playBuffer,
          SILENCE_FRAME.slice(0, FRAME_SIZE - playBuffer.length)
        ]);
        playBuffer = Buffer.alloc(0);
      } else {
        // Send silence frame
        frame = SILENCE_FRAME;
      }
```

- **Constants:** `FRAME_SIZE = 160`, `FRAME_INTERVAL = 20` ms.

### How they are sent to Twilio

- Twilio media WebSocket expects `event: "media"` with base64-encoded payload.
- Each tick of the pace timer sends one frame (or silence if buffer empty):

```273:278:src/server-rse.js
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") }
        }));
```

### Whether buffers are tied to response IDs

- **No.** There is a single `playBuffer` per call. Response identity is tracked separately:
  - `currentResponseId` is set from `event.response?.id` on `response.created` and cleared on `response.done` (when `event.response?.id === currentResponseId`).
  - Audio chunks from OpenAI do not carry `response_id` in the event payload; the server does not tag buffer segments by response ID.
  - Transcripts are tied to the “current” response implicitly: `expectedTranscript` is set when a prompt is sent, and `actualTranscript` is set from `response.audio_transcript.done` for that same logical response.

---

## 2. Response Lifecycle Handling

### How response.create is triggered

- **Greeting:** After `session.updated` (and stream ready), `sendGreeting()` sends a single `response.create` with instructions to say exactly `GREETING.primary`.
- **State prompts:** `sendStatePrompt(prompt)` is used for all scripted prompts (name, phone, email, confirmation, closing, etc.). It sends `response.create` with strict instructions that include the exact prompt text.
- **Recovery / fallbacks:** Watchdog, silence recovery, confirmation recovery, and TTS failure retry also call `sendStatePrompt(...)` or `sendGreetingRetry()`.

Example (greeting):

```1573:1582:src/server-rse.js
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Greet the caller. Say exactly: "${GREETING.primary}"
...
        max_output_tokens: 300
      }
    }));
```

Example (state prompt):

```2204:2212:src/server-rse.js
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: instructions,
        max_output_tokens: maxTokens,
        temperature: 0.6  // Minimum allowed by OpenAI Realtime API
      }
    }));
```

### How active responses are tracked

- **Flags:**
  - `responseInProgress`: set `true` on `response.created` (and in `sendGreeting` / `sendStatePrompt` before sending); set `false` when response completes, is cancelled, or buffer empties after `audioDoneReceived`.
  - `tts_active`: set `true` on `response.created`; set `false` when TTS is considered done (buffer empty + `audioDoneReceived`, or on cancel/hallucination/incomplete handling).
  - `currentResponseId`: set from `event.response?.id` on `response.created`; set `null` when `response.done` matches this ID.
- **Overlap guard:** `sendStatePrompt` and `sendGreeting`/`sendGreetingRetry` check `responseInProgress` and skip sending a new prompt if true:

```2092:2099:src/server-rse.js
  function sendStatePrompt(prompt) {
    if (openaiWs?.readyState !== WebSocket.OPEN) return;
    if (_callCompleted) return;
    clearWatchdog();
    if (responseInProgress) {
      console.log(`⏳ Skipping prompt - response in progress`);
      return;
    }
```

### How response.completed, response.cancelled, and response.error are handled

- **Single event:** The API sends `response.done` with `event.response?.status` one of: `completed`, `cancelled`, `incomplete` (no separate `response.completed` or `response.cancelled` event).
- **response.done (cancelled):**

```725:732:src/server-rse.js
        if (status === "cancelled") {
          console.log(`⚠️ Response CANCELLED`);
          // Don't send any new prompts - we cancelled for a reason
          // Either waiting for transcription, or user barged in
          // Reset tracking
          currentPromptText = null;
          expectedTranscript = null;
          actualTranscript = null;
```

  - Buffer is **not** explicitly cleared here; it is typically already cleared on barge-in (`speech_started`) when the user interrupted.

- **response.done (incomplete):** Long branch: protected states (CONFIRMATION, CLOSE) may not start recovery; ENDED triggers goodbye buffer-then-hangup; no-audio case retries up to `MAX_RETRIES_PER_PROMPT` then transfer; partial-audio case may treat as success if transcript matches and spelling/audio length checks pass; otherwise retry. On retry, **playBuffer is intentionally not cleared** so remaining good audio keeps playing and retry audio is appended.

- **response.done (completed):** Retry counters cleared, `currentPromptText` / `expectedTranscript` / `actualTranscript` cleared, confirmation/close state flags updated, goodbye handling if ENDED. Then `responseInProgress`, `tts_active`, `audioStreamingStarted` are reset.

- **error (OpenAI WebSocket message type "error"):** Only voice fallback is handled; **no buffer clear**, no explicit response lifecycle reset:

```1261:1273:src/server-rse.js
      case "error":
        const errorMsg = event.error?.message || JSON.stringify(event.error);
        console.error(`❌ OpenAI error: ${errorMsg}`);
        
        // Check for voice-related errors and fall back
        if (!voiceInitialized && errorMsg.toLowerCase().includes('voice')) {
          ...
        }
        break;
```

- There is **no** separate `response.error` event handler; only the generic `error` event.

### Whether multiple responses can exist simultaneously

- **Not by design.** The code avoids starting a second response while one is active:
  - `sendStatePrompt` and greeting paths check `responseInProgress` and return without sending another `response.create`.
  - Only one `currentResponseId` is stored; when a new response starts, it overwrites the previous (and `response.done` only clears it when the IDs match).
- **Buffer behavior:** On `response.created` the buffer is **not** cleared; new audio is appended. So if the API ever sent overlapping responses, their audio would be interleaved in one buffer. The guards prevent the **server** from requesting overlap; they do not tag or separate buffer regions by response.

---

## 3. Hallucination Guard Logic

### Exact validation logic for greeting (and all scripted prompts)

- **Expected transcript:** For every scripted prompt (including greeting), the server sets `expectedTranscript = <exact prompt text>` when sending (e.g. `sendGreeting` sets `expectedTranscript = GREETING.primary`; `sendStatePrompt(prompt)` sets `expectedTranscript = prompt`).
- **Actual transcript:** From `response.audio_transcript.done`, the server sets `actualTranscript = event.transcript`.
- **Validation:** Only in `response.audio_transcript.done`:

  - Split expected into words (by whitespace), filter to words length > 3 → `expectedWords`.
  - For each `expectedWords` word, check if `actualTranscript.toLowerCase()` includes that word → `matchingWords`.
  - **Match ratio:** `matchRatio = matchingWords.length / expectedWords.length` (or 1 if no expected words).

```568:576:src/server-rse.js
          if (expectedTranscript && actualTranscript) {
            const expected = expectedTranscript.toLowerCase();
            const actual = actualTranscript.toLowerCase();
            // Check if the actual transcript contains key words from expected
            const expectedWords = expected.split(/\s+/).filter(w => w.length > 3);
            const matchingWords = expectedWords.filter(w => actual.includes(w));
            const matchRatio = expectedWords.length > 0 ? matchingWords.length / expectedWords.length : 1;
            
            if (matchRatio < 0.3 && actualTranscript.length > 20) {
```

- **Rejection condition:** If `matchRatio < 0.3` **and** `actualTranscript.length > 20`, the response is treated as hallucinated (off-script).
- **Spelling prompts:** There is a separate check that skips this rejection for spelling-style prompts (e.g. "V A N. C A U.") so they are not falsely rejected by the word-length filter:

```553:556:src/server-rse.js
        // LOGGING: Track if this was a spelling prompt
        if (expectedTranscript && /\b([A-Z]\s){2,}[A-Z]\.?\b/.test(expectedTranscript)) {
          console.log(`🔤 TTS SPELLING AUDIO DONE: ${audioSeconds}s of audio generated for spelled content`);
        }
```

  - The hallucination check still runs for spelling prompts; the only special case is logging. So greeting and all other scripted prompts use the same 30% / length > 20 rule.

### What happens on rejection (hallucination detected)

1. **Log:** "AI said (rejected - not script)", then error logs with expected/got/match ratio.
2. **Count:** If same prompt text as last hallucination, `hallucinationCount++`; else `hallucinationCount = 1`, `lastHallucinationPrompt = expectedTranscript`.
3. **Clear buffer and flags:**  
   `playBuffer = Buffer.alloc(0)`, `responseInProgress = false`, `tts_active = false`, `audioStreamingStarted = false`.
4. **If hallucinationCount >= MAX_HALLUCINATION_RETRIES (3):**
   - Reset counters; force state progression (e.g. CONFIRMATION → CLOSE, CLOSE → ENDED with goodbye, or send “I'm sorry, let me continue…”).
   - Do **not** resend the same prompt.
5. **Else:**
   - Send `response.cancel` (no `response_id` in the cancel call in the resend path).
   - After 300 ms, resend the **same** prompt via `sendStatePrompt(promptToResend)` (or wait for user to stop speaking then resend).

```594:678:src/server-rse.js
              // CRITICAL: Clear the bad audio
              playBuffer = Buffer.alloc(0);
              ...
              if (hallucinationCount >= MAX_HALLUCINATION_RETRIES) {
                ...
                setTimeout(() => { ... sendStatePrompt(CLOSE.anything_else); ... sendStatePrompt(goodbyePrompt); ... sendStatePrompt("I'm sorry, let me continue. " + ...); }, 300);
                return;
              }
              ...
              openaiWs.send(JSON.stringify({ type: "response.cancel" }));
              ...
              setTimeout(() => {
                ...
                sendStatePrompt(promptToResend);
              }, 300);
```

### What happens after max retries

- After `MAX_HALLUCINATION_RETRIES` (3) for the same prompt:
  - Counters reset.
  - State is advanced as above (CONFIRMATION → CLOSE, CLOSE → ENDED + goodbye, or generic “I'm sorry, let me continue” + next prompt).
  - The problematic prompt is not re-sent again.

---

## 4. Buffer Clearing Logic

### When exactly audio buffers are cleared

| Trigger | Clears `playBuffer`? | Location |
|--------|----------------------|----------|
| **response.created** | **No** (comment: let existing audio finish; new audio appended) | ~489–491 |
| **Barge-in (speech_started)** | **Yes** (except protected prompt with >1600 bytes remaining, or ENDED) | 1117 |
| **Hallucination detected** | **Yes** | 594 |
| **TTS failure (checkForTTSFailure)** | **Yes** | 1541 |
| **Twilio WebSocket closed** (inside pumpFrames) | **Yes** (can’t send anymore) | 251 |
| **processUserInput** when cancelling (response in progress, no audio yet) | **Yes** | 1712 |
| **Backchannel playing when delta arrives** | **Yes** (clear to replace with real response audio) | 522 |
| **response.done (cancelled)** | No | 725–732 |
| **response.done (incomplete)** | No (intentionally keep buffer for remaining good audio) | 970–972 |
| **OpenAI disconnect (openaiWs.on("close"))** | **No** (only log) | 397–399 |
| **Twilio disconnect (twilioWs.on("close"))** | **No** in handler; cleanup() does not clear buffer (connection gone) | 2391–2394, 2404–2441 |
| **error (OpenAI "error" event)** | **No** | 1261–1273 |

### Summary table (your checklist)

- **State transition:** No explicit clear on state transition; buffer is cleared only by the events above (e.g. barge-in, hallucination, TTS failure, Twilio closed).
- **OpenAI disconnect:** Buffer is **not** cleared on OpenAI WebSocket close.
- **Twilio disconnect:** Buffer is **not** cleared in the close handler; `cleanup()` closes timers and OpenAI socket but does not touch `playBuffer` (call is over).
- **Incomplete response:** Buffer is **not** cleared so remaining audio can play; retry audio is appended.
- **Hallucination detection:** Buffer **is** cleared.

---

## 5. Transcript vs Audio Binding

### Are transcripts and audio chunks tied to the same response ID?

- **Indirectly, by ordering.** There is no `response_id` on `response.audio.delta` or on buffer segments. Binding is by lifecycle:
  - One `currentResponseId` per “active” response.
  - When we send a prompt we set `expectedTranscript = prompt`.
  - When we receive `response.audio_transcript.done` we set `actualTranscript = event.transcript` and compare to `expectedTranscript`.
  - So the “current” response’s transcript is compared to the “current” expected prompt. Audio in `playBuffer` at that time is from the same logical response, but the buffer is not partitioned by ID.

### Is there any guard ensuring audio played matches the transcript logged?

- **Only the hallucination check.** If `response.audio_transcript.done` reports text that fails the match-ratio check, we clear the buffer so that **bad audio is not played** (or we stop treating it as valid). There is no separate check that “this exact chunk of audio” corresponds to “this exact transcript segment”; we only validate the final transcript for the response against the expected script and clear the whole buffer on rejection.

---

## 6. Concurrency Controls

### Is there a global activeResponseId?

- **Yes:** `currentResponseId` is the single “active” response ID for the call. Set on `response.created`, cleared when `response.done` matches that ID.

### Is there a lock preventing overlapping responses?

- **Yes, at send time:**  
  - `sendStatePrompt` and `sendGreeting`/`sendGreetingRetry` require `!responseInProgress` and return without sending if a response is in progress.  
  - `processUserInput` defers to `pendingUserInput` when `tts_active`; it can also cancel the current response if `responseInProgress && !audioStreamingStarted` and then clear the buffer and send a new prompt. So only one response is *initiated* at a time from our side.

### Is there a watchdog timer for stalled streams?

- **3-second watchdog:** After `input_audio_buffer.speech_stopped`, a timer fires in `WATCHDOG_MS` (3000 ms). If no response has started (`responseInProgress` still false), it sends a fallback prompt via `sendStatePrompt(stateMachine.getNextPrompt())`. `response.created` clears this watchdog.

```1169:1180:src/server-rse.js
        watchdogTimer = setTimeout(() => {
          watchdogTimer = null;
          if (_callCompleted) return;
          if (responseInProgress) return;
          const elapsed = speechEndedAt ? Date.now() - speechEndedAt : 0;
          if (elapsed < WATCHDOG_MS) return;
          console.error(`⚠️ WATCHDOG: No response within ${WATCHDOG_MS}ms after speech_end - sending fallback`);
          const fallback = stateMachine.getNextPrompt();
          if (fallback && openaiWs?.readyState === WebSocket.OPEN) {
            sendStatePrompt(fallback);
          }
        }, WATCHDOG_MS);
```

- **TTS failure timeout:** `audioCompletionTimeout` (e.g. 8 s) detects “audio started but then stopped” and triggers `checkForTTSFailure()` (retry or transfer). So there is a form of “stalled stream” detection for TTS.

---

## 7. Prior Fixes Implemented

### What was done previously to stop the “promotion” hallucination

- The codebase docs (e.g. TESTING_ISSUES_LOG) mention “hallucination fixes” and “Name spelling + hallucination fixes” but do not use the word “promotion.” The **current** mitigation for off-script or fabricated lines is the **hallucination guard** above: compare `actualTranscript` to `expectedTranscript` by word overlap (match ratio &gt; 30%), clear buffer and retry or force state progression.

### What specific guards were added

1. **Transcript-based hallucination check** in `response.audio_transcript.done`: match ratio &lt; 0.3 and length &gt; 20 → reject, clear buffer, retry or advance state.
2. **Strict instructions in prompts:** CONFIRMATION/CLOSE/ENDED and general state prompts use “Say EXACTLY this text” and FORBIDDEN PHRASES (e.g. “Got it”, “I'll have someone”, “technician”, “schedule”, “appointment”) to reduce model drift.
3. **Greeting retry:** `sendGreetingRetry()` uses even stricter “CRITICAL - REPEAT CUT-OFF GREETING ONLY” and “Do NOT say … ‘connecting you’, ‘real person’…” to avoid the model saying something like “Got it, connecting you to a real person” after a cut-off greeting.
4. **No buffer clear on response.created:** Prevents throwing away good prior audio when a new response starts; avoids confusion when retries append.

### What was changed in system prompts

- **Script:** `src/scripts/rse-script.js` defines `GREETING.primary` (shortened for TTS length). No “promotion” or “real person” in the script text.
- **Instructions:** In `server-rse.js`, `response.create` payloads set `instructions` to strict script mode:
  - Greeting: “Say exactly: …” and “Speak at a normal conversational pace…”
  - Greeting retry: “Say EXACTLY and ONLY this text… Do NOT say … ‘real person’…”
  - CONFIRMATION/CLOSE/ENDED: “Say EXACTLY this text word-for-word” and “DO NOT mention technicians, appointments…”
  - Other states: “[STRICT SCRIPT MODE]”, “Say the EXACT text…”, “FORBIDDEN PHRASES” list including “I'll have someone”, “we'll reach out”, “technician”, “schedule”, etc.

---

## 8. Relevant Code Snippets (Quick Reference)

### Streaming handler (audio delta → buffer)

```516:528:src/server-rse.js
      case "response.audio.delta":
        if (event.delta) {
          if (backchannel.isPlaying()) {
            backchannel.stop();
            playBuffer = Buffer.alloc(0); // Clear backchannel audio
          }
          audioStreamingStarted = true;
          const audioData = Buffer.from(event.delta, "base64");
          playBuffer = Buffer.concat([playBuffer, audioData]);
          totalAudioBytesSent += audioData.length;
          lastAudioDeltaTime = Date.now();
          ...
```

### Buffer management (pump – send to Twilio)

```239:267:src/server-rse.js
  function pumpFrames() {
    ...
    paceTimer = setInterval(() => {
      ...
      if (playBuffer.length >= FRAME_SIZE) {
        frame = playBuffer.slice(0, FRAME_SIZE);
        playBuffer = playBuffer.slice(FRAME_SIZE);
      } else if (playBuffer.length > 0) {
        frame = Buffer.concat([playBuffer, SILENCE_FRAME.slice(0, FRAME_SIZE - playBuffer.length)]);
        playBuffer = Buffer.alloc(0);
      }
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: frame.toString("base64") } }));
      if (playBuffer.length === 0 && audioDoneReceived && responseInProgress) {
        responseInProgress = false;
        tts_active = false;
        ...
      }
    }, FRAME_INTERVAL);
  }
```

### Response lifecycle (created / done)

```486:498:src/server-rse.js
      case "response.created":
        clearWatchdog();
        currentResponseId = event.response?.id;
        // DON'T clear playBuffer here
        responseInProgress = true;
        tts_active = true;
        actualTranscript = null;
        ...
```

```697:711:src/server-rse.js
      case "response.done":
        ...
        if (event.response?.id === currentResponseId) {
          currentResponseId = null;
        }
        if (status === "cancelled") { ... expectedTranscript = null; ... }
        else if (status === "incomplete") { ... }
        else { ... responseInProgress = false; tts_active = false; ... }
```

### Hallucination (reject + clear buffer)

```567:598:src/server-rse.js
          if (expectedTranscript && actualTranscript) {
            const expectedWords = expectedTranscript.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const matchingWords = expectedWords.filter(w => actual.toLowerCase().includes(w));
            const matchRatio = expectedWords.length > 0 ? matchingWords.length / expectedWords.length : 1;
            if (matchRatio < 0.3 && actualTranscript.length > 20) {
              playBuffer = Buffer.alloc(0);
              responseInProgress = false;
              tts_active = false;
              ...
            }
          }
```

---

This is the current architecture and guard behavior before any further stabilization changes.
