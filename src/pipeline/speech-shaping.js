/**
 * Text as it should be SPOKEN, for a TTS voice that gets the whole line at
 * once (the relay). The state machine's recap is a labelled list ("Name: X.
 * Phone: 973-555-0142. ..."), which a voice rattles off flat and fast, the
 * phone number most of all (Tim, Nov 9 2026). Here it becomes sentences a
 * person would say, with digits said one at a time in groups.
 *
 * Only the audio changes: the transcript, the prompt counters and the state
 * machine keep the original text.
 */

const spaced = (digits) => String(digits).split('').join(' ');

/** "973-555-0142" -> "9 7 3, 5 5 5, 0 1 4 2" (commas are the pauses). */
function spokenPhone(text) {
  return String(text || '').replace(/\b(\d{3})[-.](\d{3})[-.](\d{4})\b/g, (_, a, b, c) => `${spaced(a)}, ${spaced(b)}, ${spaced(c)}`);
}

const RECAP_LABEL = /\b(Name|Phone|Email|Address|System|Issue|Availability): /;
const RECAP_SENTENCE = {
  Name: (v) => `I have your name as ${v}.`,
  Phone: (v) => `Your phone number is ${v}.`,
  Email: (v) => `Your email is ${v}.`,
  // The zip is said digit by digit, after a pause.
  Address: (v) => `The address is ${v.replace(/,?\s+(\d{5})$/, (_, zip) => `, ${spaced(zip)}`)}.`,
  System: (v) => `For the system, I have ${v}.`,
  Issue: (v) => `The issue I noted is ${v}.`,
  Availability: (v) => `And for availability, ${v}.`,
};

function shapeRecap(text) {
  const m = text.match(/^(.*?)(\s*Is everything correct\?)\s*$/s);
  if (!m || !RECAP_LABEL.test(m[1])) return text;
  const pieces = m[1].split(new RegExp(RECAP_LABEL.source, 'g')); // [intro, label, value, label, value, ...]
  const out = [pieces[0].trim()];
  for (let i = 1; i + 1 < pieces.length; i += 2) {
    const value = pieces[i + 1].trim().replace(/\.+$/, '');
    if (value) out.push(RECAP_SENTENCE[pieces[i]](value));
  }
  out.push('Is everything correct?');
  return out.filter(Boolean).join(' ');
}

function shapeForSpeech(text) {
  return spokenPhone(shapeRecap(String(text || '')));
}

module.exports = { shapeForSpeech, spokenPhone };
