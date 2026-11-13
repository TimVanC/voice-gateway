/**
 * Text as it should be SPOKEN, for a TTS voice that gets the whole line at
 * once (the relay). The state machine's recap is a labelled list ("Name: X.
 * Phone: 973-555-0142. ..."), which a voice rattles off flat and fast, the
 * phone number most of all (Tim, Nov 9 2026). Here it becomes what a person
 * would say, with digits said one at a time in groups.
 *
 * Nov 13 2026: testers found the sentence-per-field version ("I have your
 * name as... Your phone number is... Your email is...") long-winded (29 s on
 * v4 turbo). It is now one breath per group: "Daniel Brooks, phone 9 7 3,
 * 5 5 5, 0 1 4 2, email daniel at example dot com. The address is 27 Maple
 * Avenue, Montclair, New Jersey, 0 7 0 4 2. Furnace, about 10 years old,
 * completely out. And for availability, weekday mornings. Did I get all that
 * right?"
 *
 * Only the audio changes: the transcript, the prompt counters and the state
 * machine keep the original text.
 */

const spaced = (digits) => String(digits).split('').join(' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "973-555-0142" -> "9 7 3, 5 5 5, 0 1 4 2" (commas are the pauses). */
function spokenPhone(text) {
  return String(text || '').replace(/\b(\d{3})[-.](\d{3})[-.](\d{4})\b/g, (_, a, b, c) => `${spaced(a)}, ${spaced(b)}, ${spaced(c)}`);
}

const RECAP_LABEL = /\b(Name|Phone|Email|Address|System|Issue|Availability): /;

function shapeRecap(text) {
  const m = text.match(/^(.*?)(\s*Is everything correct\?)\s*$/s);
  if (!m || !RECAP_LABEL.test(m[1])) return text;
  const pieces = m[1].split(new RegExp(RECAP_LABEL.source, 'g')); // [intro, label, value, label, value, ...]
  const v = {};
  for (let i = 1; i + 1 < pieces.length; i += 2) {
    const value = pieces[i + 1].trim().replace(/\.+$/, '');
    if (value) v[pieces[i]] = value;
  }
  const out = [pieces[0].trim()];
  // Who and how to reach them, in one breath.
  const contact = [v.Name, v.Phone && `phone ${v.Phone}`, v.Email && `email ${v.Email}`].filter(Boolean);
  if (contact.length) out.push(`${cap(contact.join(', '))}.`);
  // The zip is said digit by digit, after a pause.
  if (v.Address) out.push(`The address is ${v.Address.replace(/,?\s+(\d{5})$/, (_, zip) => `, ${spaced(zip)}`)}.`);
  const problem = [v.System, v.Issue].filter(Boolean);
  if (problem.length) out.push(`${cap(problem.join(', '))}.`);
  if (v.Availability) out.push(`And for availability, ${v.Availability}.`);
  out.push('Did I get all that right?');
  return out.filter(Boolean).join(' ');
}

function shapeForSpeech(text) {
  return spokenPhone(shapeRecap(String(text || '')));
}

module.exports = { shapeForSpeech, spokenPhone };
