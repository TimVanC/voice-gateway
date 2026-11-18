/**
 * When Ava asks a caller to spell their email, and how the spelling is read.
 *
 * An email said as words is written the way it sounds: "ramesh dot iyer" came
 * out "ramish.ayer" on a real call (Nov 18 2026), and reading it back as words
 * sounds the same as the right one, so the caller says yes to a wrong address.
 * So when the part before the @ is not made of everyday names and words, and
 * the caller did not spell it, Ava asks them to spell that part. Once.
 *
 *   emailIsPlain('john.smith@gmail.com', 'john dot smith at gmail dot com')    -> true  (not asked)
 *   emailIsPlain('ramish.ayer@example.com', 'ramish dot ayer at example ...')  -> false (asked)
 *   parseEmailSpelling('R, A, M, E, S, H, dot, I, Y, E, R', 'ramish.ayer@example.com') -> 'ramesh.iyer'
 */
const { COMMON_SURNAMES, LETTER_SOUNDS, FILLER, closeness, spelledIn } = require('./name-spelling');

const EMAIL_SPELL_QUESTION = 'Could you spell the part before the at sign for me?';
const EMAIL_SPELL_REASK = 'Sorry, could you spell the part before the at sign once more, one letter at a time?';

// Common US first names (and the short forms people put in an email address).
const COMMON_FIRST_NAMES = new Set(`
james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark donald
steven paul andrew joshua kenneth kevin brian george edward ronald timothy jason jeffrey ryan jacob gary nicholas eric
jonathan stephen larry justin scott brandon benjamin samuel gregory frank alexander raymond patrick jack dennis jerry
tyler aaron jose adam henry nathan douglas zachary peter kyle walter ethan jeremy harold keith christian roger noah
gerald carl terry sean austin arthur lawrence jesse dylan bryan joe jordan billy bruce albert willie gabriel logan alan
juan wayne roy ralph randy eugene vincent russell elijah louis bobby philip johnny mary patricia jennifer linda
elizabeth barbara susan jessica sarah karen nancy lisa betty margaret sandra ashley kimberly emily donna michelle
dorothy carol amanda melissa deborah stephanie rebecca sharon laura cynthia kathleen amy shirley angela helen anna
brenda pamela nicole emma samantha katherine christine debra rachel catherine carolyn janet ruth maria heather diane
virginia julie joyce victoria olivia kelly christina lauren joan evelyn judith megan cheryl andrea hannah martha
jacqueline frances gloria ann teresa kathryn sara janice jean alice madison doris abigail julia judy grace denise amber
marilyn beverly danielle theresa sophia marie diana brittany natalie isabella charlotte rose alexis kayla mike dave
dan tom bob bill jim steve chris matt tony rob rick nick ben sam greg pete ken ron tim jeff josh andy alex max luke
liam mason owen caleb isaac evan connor carlos luis miguel jorge pedro diego kate katie beth sue jen jenny liz becky
cathy cindy debbie pam peggy tina lori tracy stacy wendy erin holly jill kim lynn tammy carmen rosa elena sofia lucia
ana angel derek marcus travis shawn chad craig todd troy dustin cody shane brett corey darren glenn dale neil
jamal chloe nina pat irene nora victor jon summer andre walt deb debby tommy jimmy danny kenny ronnie eddie ed ted
fred freddie al hal ray lou stan gus hank herb vic vince phil doug don ross clark grant reid drew wes wesley trevor
gavin colin ian ivan oscar hugo felix leo theo eli ezra levi jude joel seth jared jake blake chase cole colton
hunter parker carter cooper tanner spencer preston garrett brady bryce riley casey jamie robin terri sandy mandy
candy missy trish tricia patty patti patsy maggie meg molly polly sally sallie nellie ellie ella ellen eleanor elaine
eileen irma ida iris ivy eva eve evie ava mia zoe lily lucy ruby stella violet hazel pearl opal june april may joy
faith hope dawn gail gayle gwen glenda greta ingrid heidi helga elsa erica erika monica veronica valerie vanessa
vicky vicki vivian yvonne yolanda wanda rhonda ramona regina renee rita roberta rosemary roxanne sabrina sheila
shelly shelley sherry sheri sonia sonya stacey tara tamara tanya tonya tasha latoya lakisha keisha kiara kendra
kelsey kristen kristin kristina krista kris kara kari karla carla carly carrie connie claire clara cora courtney
crystal daisy darlene deanna delores dolores dianne dina dora edith edna elsie esther ethel eunice fay faye fern
flora florence geraldine gladys harriet ida jackie jacquelyn jan jana jane janelle janine jeanette jeanne jenna
joann joanna joanne jodi jody josephine josie juanita kay kaye kathy katrina kerry kirsten laurie leah leslie
lillian lois lola loretta lorraine louise lydia lynne mabel madeline marcia margie marian marianne marjorie marlene
marsha maureen maxine melanie melinda meredith miriam mona muriel myra myrtle nadine naomi natasha nell nikki noelle
norma olga paige paula pauline penny phyllis priscilla rachael rena rosalie roslyn ruthie sadie selma shari shauna
sheryl sophie sylvia thelma tiffany toni trudy vera verna vicki viola wilma winifred adrian alberto alfred alvin
amos archie arnold barry bernard bert brad bradley brent bret brendan brock byron calvin cameron cecil cedric
chester clarence claude clay clayton clifford clint clinton clyde curtis damon darnell darrell darryl dean
dewayne dominic dominick duane dwayne dwight earl edgar edmund edwin elliot elliott elmer emanuel emmett ernest
ernie everett floyd forrest francis franklin frederick garry gene gilbert gordon graham guy harvey hector herbert
herman homer horace howard hubert hugh irving isaiah jackson javier jay jeffery jerome jimmie joey johnnie jonas
julian julio julius kelvin kent kirk kurt lamar lance landon lee leon leonard leroy leslie lester lewis lloyd
lonnie lorenzo luther lyle malcolm manuel marc marco mario marshall martin marvin mathew maurice melvin merle
micah mickey milton mitchell morris moses myron nathaniel ned nelson norman oliver omar orlando otis pablo perry
quentin rafael ramon randall raul reggie reginald rex ricardo rickey ricky roberto rod roderick rodney roland
roman ronnie roosevelt rudy rufus russ salvador sammy sergio sidney simon sonny stanley stuart sylvester terrance
terrence theodore tomas tracy tyrone vernon virgil wade wallace warren wendell wilbur wilfred willard willis
winston woodrow xavier zach zack zane
`.split(/\s+/).filter(Boolean));

// Words people put in an address that are not names.
const GENERIC = new Set(`
info sales office contact admin support service services billing accounts mail email home family the and hvac heating
cooling plumbing electric energy company group team shop store house farm realty properties property management
construction builders landscaping rentals maintenance facilities manager owner hello help desk front news work job
`.split(/\s+/).filter(Boolean));

const lettersOf = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const localOf = (email) => String(email || '').split('@')[0].toLowerCase();
/** "j_tran88" -> ["j", "tran"]; "ramish.ayer" -> ["ramish", "ayer"]. */
const chunksOf = (local) => String(local || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** Is this run of letters made of everyday names and words, with at most two initials in front and one behind ("jsmith", "marialopez")? */
function madeOfKnownWords(chunk, extra = []) {
  const known = (w) => w.length >= 3 && (COMMON_FIRST_NAMES.has(w) || COMMON_SURNAMES.has(w) || GENERIC.has(w) || extra.includes(w));
  const seg = (s, lead) => {
    if (s.length <= 1) return true; // nothing left, or one initial at the end
    for (let n = s.length; n >= 3; n--) if (known(s.slice(0, n)) && seg(s.slice(n), 2)) return true;
    return lead < 2 && seg(s.slice(1), lead + 1);
  };
  return seg(chunk, 0);
}

/**
 * Can the address be trusted as heard? Every run of letters before the @ is either everyday words
 * (or the last name the caller already spelled), or was spelled out in this turn.
 */
function emailIsPlain(email, transcript = '', spelledLastName = '') {
  const extra = String(spelledLastName || '').toLowerCase().split(/\s+/).map(lettersOf).filter((w) => w.length >= 3);
  if (extra.length > 1) extra.push(extra.join(''));
  const before = String(transcript || '').split(/\bat\b|@/i)[0];
  return chunksOf(localOf(email)).every((c) => madeOfKnownWords(c, extra) || spelledIn(before, c));
}

const SEPARATORS = { dot: '.', period: '.', point: '.', underscore: '_', dash: '-', hyphen: '-', minus: '-' };
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EMAIL_FILLER = new Set(['email', 'address', 'part', 'before', 'sign', 'case', 'all', 'together', 'word', 'number', 'numbers', 'first', 'just', 'again', 'here', 'goes', 'of', 'course', 'thing', 'whole', 'then']);

/**
 * Read a spelled-out email: "R, A, M, E, S, H, dot, I, Y, E, R", "d as in dog, kowalski, K O W A L S K I, seven two",
 * "r-a-m-e-s-h dot i-y-e-r at example dot com" (what follows the "at" is left as it is on file).
 * Returns the part before the @, or null when the turn is not plainly a spelling (the model reads it then).
 * `heardEmail` is the address as first heard: it shows where a dot goes, and which part a short spelling replaces.
 */
function parseEmailSpelling(text, heardEmail = '') {
  const raw = String(text || '').replace(/[‘’]/g, "'");
  if (!raw.trim() || /\?/.test(raw)) return null;
  const all = raw.replace(/@/g, ' at ').replace(/\bdouble[- ]u\b/gi, ' w ')
    .replace(/([a-z0-9]{2,})\.(?=[a-z0-9]{2,})/gi, '$1 dot ') // "ramesh.iyer" as the transcriber wrote it
    .replace(/[.,;:!\-–—/]+/g, ' ').split(/\s+/).filter(Boolean);
  const stop = all.findIndex((tok, i) => i > 0 && tok.toLowerCase() === 'at');
  const tokens = stop > 0 ? all.slice(0, stop) : all;
  const single = (x) => /^[a-z]$/.test(x);
  const letterish = (x) => single(x) || /^\d+$/.test(x) || SEPARATORS[x] || x === 'as' || x === 'double' || x in UNITS;
  const segs = []; // { t: 'L' letters | 'W' a word said whole | 'S' separator | 'D' digits, v }
  const push = (t, v) => { const last = segs[segs.length - 1]; if (last && last.t === t && t !== 'W' && t !== 'S') last.v += v; else segs.push({ t, v }); };
  let plain = 0;
  let sounds = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const w = tok.toLowerCase().replace(/'s$/, '');
    const next = (tokens[i + 1] || '').toLowerCase();
    const prev = (tokens[i - 1] || '').toLowerCase();
    if (SEPARATORS[w]) { push('S', SEPARATORS[w]); continue; }
    if (/^\d+$/.test(w)) { push('D', w); continue; }
    if (w === 'double' && (single(next) || next in UNITS || /^\d$/.test(next))) {
      if (single(next)) { push('L', next + next); plain += 2; } else { const dgt = String(next in UNITS ? UNITS[next] : next); push('D', dgt + dgt); }
      i++; continue;
    }
    if (single(w)) {
      // "I" and "a" are words too: they count as letters only next to other letters.
      if ((w === 'i' || w === 'a') && !letterish(next) && !letterish(prev)) continue;
      push('L', w);
      plain++;
      if (next === 'as' && (tokens[i + 2] || '').toLowerCase() === 'in' && tokens[i + 3]) i += 3; // "D as in dog"
      else if ((next === 'like' || next === 'for') && tokens[i + 2]) i += 2;
      continue;
    }
    if (w in TENS) { const u = next in UNITS && UNITS[next] > 0 ? UNITS[next] : 0; push('D', String(TENS[w] + u)); if (u) i++; continue; }
    if (w in TEENS) { push('D', String(TEENS[w])); continue; }
    if (w in UNITS && w !== 'one') { push('D', String(UNITS[w])); continue; }
    if (w === 'one' && (letterish(next) || letterish(prev))) { push('D', '1'); continue; }
    // "RAMESH": letters the transcriber wrote as one block.
    if (/^[A-Z]{2,}$/.test(tok) && w !== 'ok') { push('L', w); plain += w.length; continue; }
    if (FILLER.has(w) || EMAIL_FILLER.has(w)) continue;
    if (LETTER_SOUNDS[w] && (single(next) || single(prev))) { push('L', LETTER_SOUNDS[w]); sounds++; continue; }
    const word = w.replace(/[^a-z0-9]/g, '');
    if (word) push('W', word);
  }
  if (plain < 2 || sounds > plain) return null;
  const heardLocal = localOf(heardEmail);
  const runs = segs.filter((s) => s.t === 'L').map((s) => s.v);
  const firstLetters = segs.findIndex((s) => s.t === 'L');
  const coversHeard = heardLocal && closeness(runs.join(''), lettersOf(heardLocal)) >= 0.6;
  // "Kowalski, K O W A L S K I": the word said whole next to its own spelling is not part of the address.
  const kept = segs.filter((s, i) => !(s.t === 'W' && (runs.some((r) => closeness(s.v, r) >= 0.5) || (coversHeard && i < firstLetters))));
  if (kept.filter((s) => s.t === 'W').length > 2) return null; // a sentence, not a spelling
  let local = kept.map((s) => s.v).join('').replace(/[._-]{2,}/g, (m) => m[0]).replace(/^[._-]+|[._-]+$/g, '');
  if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(local) || local.length < 2) return null;

  if (heardLocal && !/[._-]/.test(local)) {
    const parts = heardLocal.split(/([._-])/); // ["ramish", ".", "ayer"]
    const heardChunks = parts.filter((p, i) => i % 2 === 0);
    if (heardChunks.length === 2 && closeness(local, lettersOf(heardLocal)) >= 0.6) {
      // Spelled straight through: the dot goes where it was heard.
      let best = null;
      for (let i = 1; i < local.length; i++) {
        const a = closeness(local.slice(0, i), heardChunks[0]);
        const b = closeness(local.slice(i), heardChunks[1]);
        if (a >= 0.5 && b >= 0.5 && (!best || a + b > best.score)) best = { i, score: a + b };
      }
      if (best) local = `${local.slice(0, best.i)}${parts[1]}${local.slice(best.i)}`;
    } else if (heardChunks.length > 1 && closeness(local, lettersOf(heardLocal)) < 0.6) {
      // Only the hard part was spelled ("I, Y, E, R" for ramish.ayer): it replaces the part it sounds like.
      let best = null;
      heardChunks.forEach((c, n) => { const score = closeness(local, c); if (score >= 0.5 && (!best || score > best.score)) best = { n, score }; });
      if (best) { parts[best.n * 2] = local; local = parts.join(''); }
    }
  }
  return local;
}

/**
 * The first name was heard "Ramish" and the caller spelled the email r, a, m, e, s, h: the spelling is the better one.
 * Only for a first name that is not an everyday one. Returns the corrected name, or null.
 */
function firstNameFromEmail(firstName, email) {
  const heard = lettersOf(firstName);
  if (heard.length < 3 || COMMON_FIRST_NAMES.has(heard)) return null;
  const hit = chunksOf(localOf(email)).find((c) => c !== heard && c[0] === heard[0] && Math.abs(c.length - heard.length) <= 1 && closeness(c, heard) >= 0.7);
  return hit ? hit[0].toUpperCase() + hit.slice(1) : null;
}

module.exports = { COMMON_FIRST_NAMES, EMAIL_SPELL_QUESTION, EMAIL_SPELL_REASK, emailIsPlain, madeOfKnownWords, parseEmailSpelling, firstNameFromEmail };
