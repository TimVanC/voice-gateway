AI Receptionist System Rules

This file defines non negotiable architectural constraints.
All code must comply.

1. Call State Machine

Valid states:

greeting

collecting_name

collecting_phone

collecting_email

collecting_address

collecting_issue

collecting_availability

recap

anything_else

closing

completed

Rules:

State transitions must be explicit and linear.

Required fields cannot be skipped.

A state cannot re-enter once completed.

completed is terminal. No logic runs after this state.

2. Field Lifecycle

Each field must contain:

value

confirmed (boolean)

locked (boolean)

Rules:

Once confirmed is true, locked must immediately be set to true.

Locked fields cannot be modified or appended to.

Corrections overwrite the value. They never append.

Parsing must be disabled during recap and closing states.

3. Spelling Mode

When letter by letter spelling is detected:

Enter spelling_mode.

Accept only tokens A through Z and the word "space".

Ignore all other tokens.

Assemble string deterministically.

Force confirm.

Lock field.

Exit spelling_mode.

No language model interpretation allowed during spelling mode.

4. TTS Lifecycle

When TTS is active, no state transitions are allowed.

Do not listen while speaking.

Only transition after TTS complete event fires.

Hangup only after final TTS completes plus a short delay.

Mid sentence cutoffs are not allowed.

5. Negative Intent Routing

If state == anything_else and user expresses:

no

nope

nothing else

that’s all

Then:

Transition immediately to closing.

Play closing message once.

Transition to completed.

Hang up.

Silence after negative response is not allowed.

6. Model Isolation

Each call must:

Instantiate a fresh model session.

Not reuse conversation memory.

Not share buffers between calls.

Be hard locked to English.

Reject unrelated output.

Discard and regenerate any off domain content.

7. Summary Construction

Call summary must be built from structured fields only.

Never summarize from transcript slices.

Include all detected system types.

Include urgency if mentioned.

Why this matters.

You are building a deterministic intake system, not a chatbot.
Autonomous behavior must be constrained.

8. Field Confirmation in Conversation History

When a field is verified and accepted, two things must happen immediately:

Inject the verified value as a user message.

Inject a corresponding assistant acknowledgment into the conversation history.

Rules:

Never inject only the user value. OpenAI will re-ask the field if no assistant confirmation exists.

The assistant message must explicitly state the captured value (e.g. "Got it, I have your email as tim@example.com.").

Only after both messages are injected may the next field question be triggered.

This prevents the model from re-asking a field it has already received.

9. Email Validation

Email fields require explicit format validation after normalization, not just presence checks.

Rules:

A valid email must have exactly one @ symbol, a non-empty local part, and a known TLD.

Detecting @ alone is not sufficient. Do not boost confidence on malformed input.

Spoken formats such as "tim at gmail dot com" must be fully normalized before validation.

If the normalized result fails format validation, re-ask once. After two failed attempts, accept and flag for review.

Field-specific confidence thresholds apply:

Email: verify if confidence < 0.60

Phone: verify if confidence < 0.55

Name: verify if confidence < 0.50

Issue description: verify if confidence < 0.35

A single flat threshold of 0.40 across all field types is not acceptable.

10. Audio Pipeline Integrity

The audio conversion chain is: Twilio input → OpenAI → ElevenLabs → FFmpeg → Twilio output.

Rules:

FFmpeg must detect the actual sample rate of ElevenLabs output before conversion. Do not hardcode an assumed input rate.

Use the resampling utilities already available in src/resample.js. They exist and must be used in the production audio path.

When clearing the playback buffer during barge-in, wait for the current frame transmission to complete before clearing. Never clear mid-frame.

Multiple TTS chunks chained in rapid succession must include a buffer boundary marker to prevent mid-phoneme concatenation artifacts.

Audio distortion or pitch shifting is a sample rate mismatch, not a TTS issue. Diagnose there first.

11. Model Output Filtering

The language model can and will hallucinate off-topic phrases. These must never reach TTS.

Rules:

Before any model output is passed to TTS, run a domain relevance check.

If the output contains no reference to the caller's issue, name, contact info, scheduling, or a closing statement, discard it and do not speak it.

Log discarded outputs with the full phrase for monitoring.

Do not attempt to recover or rephrase discarded output. Regenerate or stay silent.

Consistent repeated hallucinations (same phrase across multiple calls) are a system prompt alignment issue. Tighten instructions, do not just filter.

12. Confidence-Based Prompting

Verification prompts must reflect the reason confidence is low.

Rules:

If confidence is between the field threshold and 0.55: confirm the captured value explicitly. Example: "Just to confirm, that's tim at example dot com?"

If confidence is below 0.40 or transcription quality indicators are poor: ask the user to repeat slowly. Do not read back a garbled value.

Never use the same re-ask prompt for both cases. Uncertain user and poor audio quality are different problems.

After two failed verifications on the same field, accept the best attempt, flag it internally, and move on. Do not loop indefinitely.