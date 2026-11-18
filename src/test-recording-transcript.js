#!/usr/bin/env node
/** Checks for the transcript taken from the recording (src/utils/recording-transcript.js). No network. */
const { buildHeardTurns, stereoWav } = require('./utils/recording-transcript');
const { parseWav } = require('./utils/twilio-recording');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     got      ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`}`);
}
/** An utterance with evenly spaced words. */
function u(speaker, start, end, text) {
  const ws = text.replace(/[^\w\s']/g, '').split(/\s+/).filter(Boolean);
  const step = (end - start) / ws.length;
  return { speaker, start, end, text, words: ws.map((w, i) => ({ w: w.toLowerCase(), start: start + i * step, end: start + (i + 1) * step })), confidence: 0.99 };
}
const T0 = Date.parse('2026-11-18T18:12:30Z');
const sent = (sec, text) => ({ speaker: 'ava', text, at: new Date(T0 + sec * 1000).toISOString() });

console.log('🧪 The transcript says what was on the line (the shape of the real call of Nov 18 2026)');
const server = [
  sent(0, 'Thanks for calling RSE Energy, this is Ava.'),
  sent(74, 'Got it. Could you spell the part before the at sign for me?'),
  sent(80, 'Sorry, could you spell the part before the at sign once more, one letter at a time?'),
  sent(82, 'Sure. Could you spell the part before the at sign for me?'),
  sent(150, 'Let me make sure I have this right. Name: Tim Brooks. Phone: 973-555-0142. Address: 171 Main Street, Madison, New Jersey 07940. Is everything correct?'),
];
const turns = buildHeardTurns([
  u('ava', 3.7, 9, 'Thanks for calling RSE Energy. This is Ava.'),
  u('caller', 73, 75, 'Tim at gmail dot com.'),
  u('ava', 76, 78, 'Okay. Could you spell the part'),
  u('caller', 77.3, 79.5, 'Can you spell the part of'),
  u('caller', 81.5, 82.6, 'What was that?'),
  u('ava', 84, 88.5, 'Sure. Could you spell the part before the at sign for me?'),
  u('caller', 90, 95, 'T I M.'),
  u('ava', 151, 168, 'Let me make sure I have this right. Tim Brooks, phone 9 7 3, 5 5 5, 0 1 4 2. The address is 171 Main Street, Madison, New Jersey, 0 7 9 4 0.'),
  u('caller', 167, 168.5, 'Nine four zero four.'),
  u('caller', 172, 173, 'Yes.'),
], server);
const text = turns.map((t) => `${t.speaker}: ${t.text}`);
const find = (part) => text.find((l) => l.includes(part)) || null;
check('a cut-off line shows where it stopped and what it was', find('Could you spell the part [cut off') !== null && find('The full line was: "Got it. Could you spell the part before the at sign for me?"') !== null, true);
check("Ava's own words on the caller's line are marked as an echo", find("[Not the caller: Ava's own voice echoing on the caller's line: \"Can you spell the part of\"]") !== null, true);
check('the zip heard back is an echo, not the caller', find('echoing on the caller\'s line: "Nine four zero four."') !== null, true);
check('a line that was sent but never spoken is said to be missing', find('[Not on the recording. This line of Ava\'s was sent but never spoken: "Sorry, could you spell') !== null, true);
check('a line spoken in full is left alone', find('ava: Sure. Could you spell the part before the at sign for me?'), 'ava: Sure. Could you spell the part before the at sign for me?');
check('what the caller really said is kept', [find('caller: What was that?'), find('caller: Yes.'), find('caller: T I M.')], ['caller: What was that?', 'caller: Yes.', 'caller: T I M.']);
check('turns are numbered in time order', turns.every((t, i) => t.sequence === i + 1 && (i === 0 || t.at >= turns[i - 1].at)), true);

const wav = parseWav(stereoWav(Int16Array.from([1, 2, 3]), Int16Array.from([-1, -2])));
check('the stereo file holds the caller on the left and Ava on the right', [Array.from(wav.channels[0]), Array.from(wav.channels[1]), wav.sampleRate], [[1, 2, 3], [-1, -2, 0], 8000]);

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All recording transcript checks passed');
process.exit(failures ? 1 : 0);
