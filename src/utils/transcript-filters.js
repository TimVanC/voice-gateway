/**
 * Transcript filters for ASR artifacts.
 *
 * Whisper-family models hallucinate stock phrases ("Thank you.", "Thanks for
 * watching!", "Bye.") when the VAD commits near-silent audio — noise blips,
 * breaths, line rustle. Observed signature in production logs: ~1.2-1.4s
 * "speech" events all transcribing to "Thank you." These phantom transcripts
 * caused greeting retries, duplicate re-asks, and cut-off prompts.
 *
 * Pure functions, exported for direct testing.
 */

// Exact-match set (after normalization). Deliberately narrow:
// - "yes"/"no"/"okay" are NEVER here — confirmations must not be eaten.
// - Multi-word real answers never exact-match, so they always pass through.
// - "goodbye"/"bye" are included: a phantom "Bye." ends calls prematurely,
//   and a genuine quick "bye" is recoverable (recovery timers re-ask).
const SILENCE_HALLUCINATIONS = new Set([
  'thank you',
  'thanks',
  'thank you very much',
  'thank you so much',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'bye bye',
  'goodbye',
  'you',
]);

const MAX_HALLUCINATION_SPEECH_MS = 2000;

/**
 * True when a transcript is almost certainly a Whisper silence-hallucination:
 * an exact known phrase AND the detected speech was under ~2s. Real polite
 * "thank you"s ride longer utterances ("okay, thank you") or longer speech
 * durations and pass through.
 * @param {string} transcript - raw transcript
 * @param {number} durationMs - detected speech duration for this turn
 */
function isLikelySilenceHallucination(transcript, durationMs) {
  if (!transcript || typeof transcript !== 'string') return false;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  if (durationMs >= MAX_HALLUCINATION_SPEECH_MS) return false;
  const normalized = transcript
    .toLowerCase()
    .replace(/[.,!?…\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return SILENCE_HALLUCINATIONS.has(normalized);
}

module.exports = { isLikelySilenceHallucination, MAX_HALLUCINATION_SPEECH_MS };
