/**
 * Callers who spell without being asked.
 *
 * Someone with a hard name does not wait for the question: "Tim Van Cowenberg,
 * V, A, N, C, A, U, W, E, N, B, E, R, G, E", or "T, V, A, N ... at gmail dot
 * com". The letters are the truth; the word said before them is only how the
 * transcriber heard it. A model reading the turn sometimes keeps the heard
 * word, drops a letter, or files "Tim Van" as the first name. So whenever a
 * turn holds a run of spelled letters, the name or the address is built from
 * the letters here, with no model in between.
 *
 *   spellingRuns('Tim Van Cowenberg. V, A, N, C, A, U, W, E, N, B, E, R, G, E.')
 *     -> [{ name: 'Vancauwenberge', before: 'Tim Van Cowenberg. ' }]
 *   nameFromSpelling(text, 'Tim Van', 'Cowenberg') -> { first: 'Tim', last: 'Van Cauwenberge' }
 *   spelledEmailIn('T, V, A, N, C, A, U, W, E, N, B, E, R, G, E at gmail dot com')
 *     -> 'tvancauwenberge@gmail.com'
 */
const { parseSpelling, closeness, formatName, dropRepeat, LETTER_SOUNDS } = require('./name-spelling');
const { parseEmailSpelling } = require('./email-spelling');

// Capitals that are not a spelled name.
const ACRONYMS = new Set(['HVAC', 'AC', 'OK', 'NJ', 'NY', 'PA', 'CT', 'USA', 'RSE', 'AM', 'PM', 'TV', 'CO', 'PO', 'LLC', 'INC', 'ID', 'DIY', 'BTU', 'UV', 'LED', 'EV', 'AI', 'ASAP']);
// Words that belong to the surname even when they were filed with the first name ("Tim Van" + "Cowenberg").
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'di', 'da', 'la', 'le', 'st', 'mc', 'mac', 'bin', 'al', 'el', 'ter', 'ten', 'den', 'der', 'du', 'dos', 'das', 'san', 'santa', 'vander', 'vande']);
const NAME_INTRO = new Set(['my', 'name', 'names', 'is', 'its', "it's", 'it', 'this', 'the', 'first', 'last', 'and', 'then', 'spelled', 'spelt', 'spell', "that's", 'thats', 'that', 'sure', 'yeah', 'yes', 'okay', 'ok', 'um', 'uh', 'so', 'well', 'hi', 'hello', "i'm", 'im', 'i', 'am', 'with', 'a', 'an', 'surname', 'like', 'as', 'in', 'of', 'course', 'for']);
const TLDS = new Set(['com', 'net', 'org', 'edu', 'gov', 'us', 'co', 'io', 'biz', 'info', 'me', 'ca', 'uk']);

const lettersOf = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const wordsOf = (s) => String(s || '').toLowerCase().split(/[^a-z']+/).map((w) => w.replace(/'/g, '')).filter(Boolean);

/**
 * Every run of three or more letters said one at a time ("V, A, N", "V-A-N", "B as in boy", "double L",
 * "space", "hyphen") or written as capitals by the transcriber ("VAN CAUWENBERGE").
 * Returns [{ name, before }]: the run as a name, and the text between the previous run and this one.
 */
function spellingRuns(text) {
  const raw = String(text || '').replace(/[‘’]/g, "'").replace(/\bnew word\b/gi, ' space ').replace(/\bdouble[- ]u\b/gi, ' w ');
  const tokens = [...raw.matchAll(/[A-Za-z0-9']+/g)].map((m) => ({ s: m[0], i: m.index, end: m.index + m[0].length }));
  const lower = (k) => (tokens[k] ? tokens[k].s.toLowerCase() : '');
  const isLetter = (k) => Boolean(tokens[k]) && /^[A-Za-z]$/.test(tokens[k].s);
  const isCaps = (k) => Boolean(tokens[k]) && /^[A-Z]{2,}$/.test(tokens[k].s) && !ACRONYMS.has(tokens[k].s);
  const found = [];
  let cur = null;
  const close = () => {
    if (cur && cur.letters >= 3 && (cur.singles >= 3 || cur.letters >= 4)) found.push(cur);
    cur = null;
  };
  const add = (k, piece, letters, single) => {
    if (!cur) cur = { parts: [], letters: 0, singles: 0, start: tokens[k].i, end: 0, lastCaps: false };
    cur.parts.push(piece);
    cur.letters += letters;
    if (single) cur.singles += letters;
    cur.end = tokens[k].end;
  };
  for (let k = 0; k < tokens.length; k++) {
    const w = lower(k);
    if (isLetter(k)) {
      // "I" and "a" are words too: letters only next to other letters.
      if ((w === 'i' || w === 'a') && !cur && !isLetter(k + 1)) continue;
      add(k, w, 1, true);
      cur.lastCaps = false;
      if (lower(k + 1) === 'as' && lower(k + 2) === 'in' && tokens[k + 3]) { k += 3; cur.end = tokens[k].end; } // "V as in Victor"
      else if (lower(k + 1) === 'like' && tokens[k + 2] && !isLetter(k + 2)) { k += 2; cur.end = tokens[k].end; }
      continue;
    }
    if (isCaps(k)) {
      const wasCaps = cur && cur.lastCaps;
      add(k, `${wasCaps ? 'space ' : ''}${w.split('').join(' ')}`, w.length, false);
      cur.lastCaps = true;
      continue;
    }
    if (cur && (w === 'space' || w === 'hyphen' || w === 'dash' || w === 'apostrophe')) { add(k, w, 0, false); cur.lastCaps = false; continue; }
    if (cur && w === 'double' && isLetter(k + 1)) { add(k, 'double', 0, false); continue; }
    // A letter the transcriber wrote as a word, inside a run: "C, A, you, W, E, N".
    if (cur && LETTER_SOUNDS[w] && (isLetter(k + 1) || isLetter(k - 1))) { add(k, LETTER_SOUNDS[w], 1, true); cur.lastCaps = false; continue; }
    if (cur && (w === 'capital' || w === 'lowercase' || w === 'then' || w === 'and') && (isLetter(k + 1) || lower(k + 1) === 'space')) continue;
    close();
  }
  close();
  const out = [];
  let prevEnd = 0;
  for (const run of found) {
    const name = parseSpelling(run.parts.join(' '));
    if (name) out.push({ name, before: raw.slice(prevEnd, run.start) });
    prevEnd = run.end;
  }
  return out;
}

/** "vancauwenberge" spelled, "Van Cowenberg" heard: the space goes where the heard name had it. */
function spaceLike(spelled, heardWords) {
  if (/[\s'-]/.test(spelled) || heardWords.length < 2) return spelled;
  let rest = lettersOf(spelled);
  const lead = [];
  for (const hw of heardWords.slice(0, -1)) {
    if (hw && rest.startsWith(hw) && rest.length > hw.length + 1) { lead.push(hw); rest = rest.slice(hw.length); } else break;
  }
  return lead.length ? formatName(`${lead.join(' ')} ${rest}`) : spelled;
}

/**
 * The caller's name from a turn in which part of it was spelled.
 * `first` and `last` are the name as heard (from the turn reader, or already on file); either may be empty.
 * Returns { first, last, spelledLast } with the spelled parts written as spelled, or null when nothing was spelled.
 */
function nameFromSpelling(text, first = '', last = '') {
  const runs = spellingRuns(text);
  if (!runs.length) return null;
  let firstWords = wordsOf(first);
  let lastWords = wordsOf(last);
  if (!firstWords.length && !lastWords.length) {
    // Nothing heard as a name: the words said before the letters are the name.
    const said = wordsOf(runs[0].before).filter((w) => !NAME_INTRO.has(w));
    firstWords = said.slice(0, 1);
    lastWords = said.slice(1);
  }
  let firstName = firstWords.length ? formatName(firstWords.join(' ')) : '';
  let lastName = lastWords.length ? formatName(lastWords.join(' ')) : '';
  let spelledLast = false;
  runs.forEach((run, n) => {
    run.name = dropRepeat(run.name, firstWords.slice(1).concat(lastWords).join('')); // the letters said twice count once
    const letters = lettersOf(run.name);
    const scoreFirst = firstWords.length ? closeness(letters, firstWords[0]) : 0;
    // The heard surname may have been split: "Tim Van" + "Cowenberg".
    const tail = firstWords.slice(1).map((w) => ({ w, fromFirst: true })).concat(lastWords.map((w) => ({ w, fromFirst: false })));
    let best = { score: 0, at: tail.length };
    for (let i = 0; i < tail.length; i++) {
      const score = closeness(letters, tail.slice(i).map((x) => x.w).join(''));
      if (score > best.score) best = { score, at: i };
    }
    const labelledFirst = /\bfirst( name)?\b[^a-z]*(is|spelled|spelt)?[^a-z]*$/i.test(run.before) && !/\blast\b[^.]*$/i.test(run.before);
    const heardTail = tail.map((x) => x.w).join('');
    // "Van Cowenberg. V, A, N" and a pause: the spelling has only begun. Keep the name as heard; the rest is on its way.
    if (best.score < 0.4 && !labelledFirst && scoreFirst < 0.6 && heardTail.startsWith(letters) && letters.length < heardTail.length * 0.6) return;
    const isFirst = !spelledLast && (labelledFirst || (scoreFirst >= 0.6 && scoreFirst > best.score && (runs.length > 1 ? n === 0 : true)));
    if (isFirst) { firstName = formatName(run.name.toLowerCase()); firstWords = [lettersOf(firstName)].concat(firstWords.slice(1)); return; }
    if (best.score >= 0.4) {
      // Heard words in front of the part that was spelled stay: with the surname if they came from it or are
      // a particle ("van"), with the first name otherwise ("Mary Ann").
      const lead = tail.slice(0, best.at);
      const keepFirst = [firstWords[0]].concat(lead.filter((x) => x.fromFirst && !PARTICLES.has(x.w)).map((x) => x.w)).filter(Boolean);
      const keepLast = lead.filter((x) => !x.fromFirst || PARTICLES.has(x.w)).map((x) => x.w);
      const fitted = spaceLike(run.name, tail.slice(best.at).map((x) => x.w));
      firstName = formatName(keepFirst.join(' '));
      lastName = `${keepLast.length ? `${formatName(keepLast.join(' '))} ` : ''}${fitted}`;
    } else {
      lastName = run.name; // nothing like it was heard: the letters are all there is
      if (firstWords.length) firstName = formatName(firstWords.join(' '));
    }
    spelledLast = true;
    lastWords = wordsOf(lastName);
    firstWords = wordsOf(firstName);
  });
  return { first: firstName, last: lastName, spelledLast };
}

/**
 * An email with letters spelled in it, read without a model: "r, a, m, e, s, h, dot, i, y, e, r, eight two at
 * outlook dot com" -> ramesh.iyer82@outlook.com. Returns the address, or null when no letters were spelled
 * or the turn holds no address.
 */
function spelledEmailIn(text) {
  const raw = String(text || '').replace(/[‘’]/g, "'").replace(/@/g, ' at ');
  if (/\?/.test(raw)) return null;
  const tokens = raw.replace(/([A-Za-z0-9])\.(?=[A-Za-z]{2,})/g, '$1 dot ').replace(/[,;:!]+/g, ' ').replace(/\.(\s|$)/g, ' ').split(/\s+/).filter(Boolean);
  const low = tokens.map((t) => t.toLowerCase());
  // The last "at" that is followed, within a few words, by "dot com".
  let at = -1;
  let end = -1;
  for (let i = low.length - 1; i >= 1 && at < 0; i--) {
    if (low[i] !== 'at') continue;
    for (let j = i + 2; j < Math.min(low.length - 1, i + 9); j++) {
      if (low[j] === 'dot' && TLDS.has(low[j + 1])) { at = i; end = j + 1; break; }
    }
  }
  if (at < 1) return null;
  while (low[end + 1] === 'dot' && /^[a-z]{2,3}$/.test(low[end + 2] || '')) end += 2; // "dot co dot uk"
  const domain = low.slice(at + 1, end + 1).map((w) => (w === 'dot' ? '.' : w === 'dash' || w === 'hyphen' ? '-' : w.replace(/[^a-z0-9-]/g, ''))).join('');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  const local = parseEmailSpelling(tokens.slice(0, at).join(' '));
  return local ? `${local}@${domain}` : null;
}

module.exports = { spellingRuns, nameFromSpelling, spelledEmailIn, spaceLike };
