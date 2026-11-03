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

/**
 * True when a transcript carries a clear yes or no anywhere in it: "Yes,
 * that's correct.", "No, that's all.", "Yep, all correct". Used by the
 * duplicate-transcript guard in CONFIRMATION/CLOSE, where the caller
 * legitimately answers two prompts in a row with the same words (the
 * availability read-back and then the final recap) and must not be told
 * "Sorry, I didn't catch that".
 * @param {string} transcript - raw transcript (any case, any punctuation)
 */
function isClearYesOrNo(transcript) {
  if (!transcript || typeof transcript !== 'string') return false;
  const normalized = transcript.toLowerCase().replace(/[‘’]/g, "'");
  return /\b(yes|yeah|yep|yup|correct|that'?s\s+(right|correct)|all\s+correct|no|nope|nah)\b/.test(normalized);
}

/**
 * When the scripted prompt names a field (phone, email, availability,
 * address), the model's line must mention it too. Catches a reply that is
 * fluent but about the wrong thing.
 */
function hasExpectedDomainKeyword(expected, actual) {
  const expectedLower = String(expected || "").toLowerCase();
  const actualLower = String(actual || "").toLowerCase();
  const keywordGroups = [
    {
      trigger: ["phone", "number", "reach"],
      required: ["phone", "number", "reach", "call"]
    },
    {
      trigger: ["email", "@", " at ", " dot "],
      required: ["email", "@", " at ", " dot ", "gmail", "yahoo", "outlook"]
    },
    {
      trigger: ["days", "times", "availability", "work best"],
      required: ["day", "days", "time", "times", "availability", "work", "best"]
    },
    {
      trigger: ["address", "street", "city", "zip"],
      required: ["address", "street", "road", "avenue", "city", "zip"]
    }
  ];
  for (const group of keywordGroups) {
    const expectedHasTrigger = group.trigger.some((kw) => expectedLower.includes(kw));
    if (!expectedHasTrigger) continue;
    const actualHasKeyword = group.required.some((kw) => actualLower.includes(kw));
    if (!actualHasKeyword) return false;
  }
  return true;
}

/**
 * On-script check for what the Realtime model actually said against the
 * state prompt the server told it to say. Word-overlap, not exact match, so
 * a recap assembled from the caller's own data ("Name: Maria Lopez. Phone:
 * 973-555-0142. ...") still passes when the model reads it back, while a
 * line about something else ("Is there anything else I can help with
 * today?") fails. Both arguments empty/null => true (nothing to compare).
 * @param {string} expectedTranscriptText - the state prompt sent to the model
 * @param {string} actualTranscriptText - response.output_audio_transcript
 */
function transcriptMatchesExpected(expectedTranscriptText, actualTranscriptText) {
  if (!expectedTranscriptText || !actualTranscriptText) return true;
  const expected = expectedTranscriptText.toLowerCase();
  const actual = actualTranscriptText.toLowerCase();
  const expectedWords = expected
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9@]/g, ""))
    .filter((w) => w.length > 3);
  if (expectedWords.length === 0) return true;
  const matchingWords = expectedWords.filter((w) => actual.includes(w));
  const matchRatio = matchingWords.length / expectedWords.length;
  const minMatches = expectedWords.length >= 6 ? 3 : 2;
  const ratioOk = matchRatio >= (expectedWords.length >= 6 ? 0.5 : 0.4);
  const keywordOk = hasExpectedDomainKeyword(expectedTranscriptText, actualTranscriptText);
  return ratioOk && matchingWords.length >= minMatches && keywordOk;
}

/**
 * A turn that is nothing but a greeting ("hello?", "hi, hello?", "hey there",
 * "hi Ava", "hello, anybody?"): the caller did not hear us, repeat the prompt.
 * A greeting followed by anything else is an answer, not a repeat request:
 * "Hi. I'm having HVAC issue." (staging call Nov 3 2026) used to get the whole
 * greeting again because the old test only looked for the word "hi".
 */
function isBareHello(transcript) {
  const lower = String(transcript || '').toLowerCase();
  return /^\W*(hello|hey|hi|hiya)(\W+(hello|hey|hi|there|ava|anybody|anyone))*\W*$/.test(lower);
}

module.exports = {
  isBareHello,
  isLikelySilenceHallucination,
  MAX_HALLUCINATION_SPEECH_MS,
  isClearYesOrNo,
  hasExpectedDomainKeyword,
  transcriptMatchesExpected,
};
