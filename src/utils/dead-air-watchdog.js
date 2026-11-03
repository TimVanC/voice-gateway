/**
 * Dead-air watchdog decisions (src/server-rse.js armWatchdog()).
 *
 * The watchdog is armed after the caller stops speaking and again whenever a
 * model response dies without delivering the scripted prompt. When it fires
 * it re-sends the current state's prompt, and every "dead-air recovery" counts
 * toward a cap that offers a live agent.
 *
 * Bug this fixes (harness runs 20261103-031419-no-heat, -033632-no-heat,
 * -031655-generator-install, PR #17 run 3): the auto-response OpenAI starts at
 * speech end is cancelled ("waiting_for_transcription"), which arms the 4 s
 * recovery. Transcription of the caller's answer regularly took longer than
 * that (median 3.8 s, up to ~4.1 s after speech end), so the recovery fired
 * first and re-asked the question the caller had just answered; the answer
 * then landed on top of the re-ask ("Conversation already has an active
 * response"), and three of those in one call offered a transfer.
 *
 * Rule: while a transcript is pending, the watchdog holds instead of
 * re-asking, up to TRANSCRIPT_WAIT_CEILING_MS after the caller stopped
 * speaking. Past the ceiling the transcript is given up on and the normal
 * recovery (and its cap) applies, so a transcript that never arrives still
 * recovers.
 *
 * Ceiling: 7 s. Staging call Nov 3 2026 20:52 UTC: the caller's first answer
 * (3.3 s of speech) got neither a transcription.completed nor a .failed from
 * OpenAI, ever (not reproducible: 14 probes with the same session config,
 * echoed greeting, reversed speech, quiet speech, all transcribed in 0.4-1.1 s;
 * 139 harness turns: median 0.5 s, p95 1.4 s, slowest 3.2 s; PR #18's slowest
 * 4.1 s). With the 10 s ceiling the caller waited 15 s in silence; 7 s keeps
 * ~3 s of headroom over the slowest transcript seen and halves the wait.
 *
 * Pure functions, exported for direct testing.
 */

// Overridable (ms) for local harness runs that force the ceiling; production uses the default.
const TRANSCRIPT_WAIT_CEILING_MS = Number(process.env.TRANSCRIPT_WAIT_CEILING_MS) || 7000;

// A committed turn whose transcript came back empty: shorter than this it is
// a blip (dropped like a silence hallucination); longer, the caller said
// something and gets the question again.
const EMPTY_TRANSCRIPT_REPROMPT_MIN_MS = 1500;

/**
 * @param {object} s
 * @param {boolean} s.callCompleted            closing already ran
 * @param {boolean} s.responseInProgress       something is already speaking
 * @param {boolean} s.speechActive             caller is mid-speech
 * @param {boolean} s.waitingForTranscription  speech ended, transcript not in yet
 * @param {number}  s.transcriptWaitedMs       ms since the caller stopped speaking
 * @param {number}  [s.transcriptWaitCeilingMs]
 * @param {boolean} s.isDeadAirRecovery        this firing counts toward the cap
 * @param {number}  s.deadAirRecoveries        recoveries so far this call
 * @param {number}  s.maxDeadAirRecoveries
 * @returns {{action: 'skip'|'hold'|'offer_transfer'|'fallback', reason: string, holdMs?: number, transcriptAbandoned?: boolean}}
 */
function decideWatchdogAction(s) {
  if (s.callCompleted) return { action: 'skip', reason: 'call_completed' };
  if (s.responseInProgress) return { action: 'skip', reason: 'response_in_progress' };
  if (s.speechActive) return { action: 'skip', reason: 'caller_speaking' };

  let transcriptAbandoned = false;
  if (s.waitingForTranscription) {
    const ceiling = s.transcriptWaitCeilingMs ?? TRANSCRIPT_WAIT_CEILING_MS;
    const remaining = ceiling - Math.max(0, s.transcriptWaitedMs || 0);
    if (remaining > 0) {
      return { action: 'hold', reason: 'transcript_pending', holdMs: remaining };
    }
    transcriptAbandoned = true;
  }

  if (s.isDeadAirRecovery && s.deadAirRecoveries >= s.maxDeadAirRecoveries) {
    return { action: 'offer_transfer', reason: 'dead_air_recoveries_exceeded', transcriptAbandoned };
  }
  return { action: 'fallback', reason: transcriptAbandoned ? 'transcript_never_arrived' : 'dead_air', transcriptAbandoned };
}

/**
 * A transcript that lands while the watchdog's re-ask is in flight is the
 * answer to that very question: cut the re-ask off and act on the answer
 * instead of queuing it behind the re-ask (which made the caller hear the
 * question again and answer it twice).
 *
 * - 'cut_now': the re-ask's response exists (response.created arrived), cancel it by id.
 * - 'cut_on_create': its response.create was sent but OpenAI has not answered
 *   with response.created yet, so there is no id to cancel and a second
 *   response.create now would be refused ("already has an active response").
 *   Hold the answer; cancel the re-ask the moment it is created, then act.
 * - 'none': nothing to cut.
 */
function transcriptSupersedesRecovery({ recoveryPromptInFlight, responseCreated, callCompleted, inEndedState }) {
  if (!recoveryPromptInFlight || callCompleted || inEndedState) return 'none';
  return responseCreated ? 'cut_now' : 'cut_on_create';
}

/**
 * transcription.completed with an empty transcript. The server used to test
 * `if (event.transcript)` and do nothing for "" (or process "\n" as a real
 * turn): the pending flag stayed set and the log showed no event at all,
 * exactly what the staging call's log looked like. The transcriber returns
 * text for everything that trips the VAD in every probe so far, so this is a
 * net, not the diagnosed cause.
 *
 * - 'skip':     call over / goodbye playing, nothing to do.
 * - 'drop':     a blip (speech shorter than EMPTY_TRANSCRIPT_REPROMPT_MIN_MS): clear
 *               the watchdog and stay quiet, like a dropped silence hallucination.
 * - 'reprompt': the caller said something we did not get: ask the current
 *               question again right away (counts toward the dead-air cap, so
 *               an echo loop ends in the live-agent offer, not forever).
 */
function decideEmptyTranscriptAction({ speechDurationMs, callCompleted, inEndedState, minRepromptMs = EMPTY_TRANSCRIPT_REPROMPT_MIN_MS }) {
  if (callCompleted || inEndedState) return 'skip';
  return (speechDurationMs || 0) >= minRepromptMs ? 'reprompt' : 'drop';
}

module.exports = {
  TRANSCRIPT_WAIT_CEILING_MS,
  EMPTY_TRANSCRIPT_REPROMPT_MIN_MS,
  decideWatchdogAction,
  decideEmptyTranscriptAction,
  transcriptSupersedesRecovery,
};
