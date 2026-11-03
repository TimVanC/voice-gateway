/**
 * Spoken numbers to digits, for transcripts from STT models that write
 * numbers as words (Deepgram Flux has no smart formatting: "nine seven three
 * five five five zero one four two"). The state machine's phone, address and
 * zip parsers expect digits, which is what Realtime's transcription and
 * Deepgram Nova-3 with smart_format produce.
 *
 *   normalizeSpokenNumbers("It's nine seven three five five five zero one four two.")
 *     -> "It's 9735550142."
 *   normalizeSpokenNumbers("Fourteen Elm Street", { cardinals: true }) -> "14 Elm Street"
 *   normalizeSpokenNumbers("eighty eight Ridge Road", { cardinals: true }) -> "88 Ridge Road"
 *   normalizeSpokenNumbers("zero seven nine oh one") -> "07901"
 *
 * Runs of three or more number words are always converted (they are digits
 * being dictated). Shorter runs ("one", "fourteen") are only converted with
 * { cardinals: true }, which the server passes in states that ask for a
 * number (phone, address), so "the one upstairs" stays words elsewhere.
 */

const UNITS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MULT = { double: 2, triple: 3 };

function wordOf(token) {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}

function isNumberWord(w) {
  return w in UNITS || w in TEENS || w in TENS || w === 'hundred' || w in MULT;
}

/**
 * Convert one run of number words to a digit string. The run is read as a
 * sequence of groups that are concatenated, the way people dictate numbers:
 * "nine seven three" = 9|7|3, "one twenty three" = 1|23, "nineteen oh five" =
 * 19|0|5, "two hundred fifteen" = 215, "double five" = 55.
 */
function runToDigits(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w in MULT && i + 1 < words.length && words[i + 1] in UNITS) {
      out.push(String(UNITS[words[i + 1]]).repeat(MULT[w]));
      i += 2;
      continue;
    }
    if (w in UNITS && words[i + 1] === 'hundred') {
      let value = UNITS[w] * 100;
      i += 2;
      if (words[i] in TENS) {
        value += TENS[words[i]];
        i++;
        if (words[i] in UNITS && UNITS[words[i]] > 0) { value += UNITS[words[i]]; i++; }
      } else if (words[i] in TEENS) {
        value += TEENS[words[i]]; i++;
      } else if (words[i] in UNITS && words[i] !== 'oh' && words[i] !== 'o') {
        value += UNITS[words[i]]; i++;
      }
      out.push(String(value));
      continue;
    }
    if (w in TENS) {
      let value = TENS[w];
      i++;
      if (words[i] in UNITS && UNITS[words[i]] > 0 && words[i] !== 'oh' && words[i] !== 'o') { value += UNITS[words[i]]; i++; }
      out.push(String(value));
      continue;
    }
    if (w in TEENS) { out.push(String(TEENS[w])); i++; continue; }
    if (w in UNITS) { out.push(String(UNITS[w])); i++; continue; }
    i++; // stray "hundred" / "double"
  }
  return out.join('');
}

function normalizeSpokenNumbers(text, { cardinals = false } = {}) {
  if (!text) return text;
  // Tokens with their trailing separators, so punctuation and spacing survive.
  const tokens = String(text).match(/[^\s,-]+|[\s,-]+/g) || [];
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const w = wordOf(tokens[i]);
    // "o" and "oh" only count inside a run ("zero seven nine oh one"), never alone.
    const startsRun = isNumberWord(w) && w !== 'o' && w !== 'oh' && w !== 'hundred' && !(w in MULT && !(wordOf(tokens[i + 2] || '') in UNITS));
    if (!startsRun) { out.push(tokens[i]); i++; continue; }
    // Collect the run: number words separated only by spaces, commas or hyphens.
    const words = [w];
    let j = i + 1;
    let lastWordIdx = i;
    while (j + 1 < tokens.length && /^[\s,-]+$/.test(tokens[j]) && isNumberWord(wordOf(tokens[j + 1]))) {
      words.push(wordOf(tokens[j + 1]));
      lastWordIdx = j + 1;
      j += 2;
    }
    const isDictation = words.length >= 3;
    // A short number right before a capitalised word is a house number
    // ("Fourteen Elm Street", "eighty eight Ridge Road"), wherever it is said.
    const nextWord = tokens[lastWordIdx + 2] || '';
    const beforeName = /^[\s]+$/.test(tokens[lastWordIdx + 1] || '') && /^[A-Z][a-z]/.test(nextWord);
    if (!isDictation && !cardinals && !beforeName) {
      for (let k = i; k <= lastWordIdx; k++) out.push(tokens[k]);
      i = lastWordIdx + 1;
      continue;
    }
    // Keep punctuation glued to the last word ("two." -> "2.").
    const trailing = tokens[lastWordIdx].replace(/^[A-Za-z]+/, '');
    out.push(runToDigits(words) + trailing);
    i = lastWordIdx + 1;
  }
  return out.join('');
}

module.exports = { normalizeSpokenNumbers, runToDigits };
