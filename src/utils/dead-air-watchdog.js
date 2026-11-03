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
 * Pure function, exported for direct testing.
 */

const TRANSCRIPT_WAIT_CEILING_MS = 10000;

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
 * A transcript that lands while the watchdog's re-ask is still playing is
 * the answer to that very question: cut the re-ask off and act on the answer
 * instead of queuing it behind the re-ask (which made the caller hear the
 * question again and answer it twice).
 */
function transcriptSupersedesRecovery({ recoveryPromptInFlight, hasActiveOutput, callCompleted, inEndedState }) {
  return Boolean(recoveryPromptInFlight && hasActiveOutput && !callCompleted && !inEndedState);
}

module.exports = {
  TRANSCRIPT_WAIT_CEILING_MS,
  decideWatchdogAction,
  transcriptSupersedesRecovery,
};
