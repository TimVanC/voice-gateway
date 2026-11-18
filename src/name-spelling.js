/**
 * When Ava asks a caller to spell their last name, and how the spelling is read.
 *
 * Twilio's transcriber writes down what a name sounds like. "Smith" comes out
 * right; "Iyer" came out "Ayar" on two real calls (Nov 17 2026) and a name
 * like Van Cauwenberge almost never survives. So a last name that is not one
 * of the common ones below is spelled out by the caller, once, and a common
 * one is not asked about at all.
 *
 *   needsSpelling('Smith')            -> false
 *   needsSpelling('Ayar')             -> true
 *   parseSpelling('I Y E R')          -> 'Iyer'
 *   parseSpelling('V as in Victor, A, N, space, C, A, U, W, E, N, B, E, R, G, E') -> 'Van Cauwenberge'
 *   lettersLine('Iyer')               -> 'I, Y, E, R'
 */

// Common US last names with one usual spelling. Anything else is spelled out.
const COMMON_SURNAMES = new Set(`
smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson thomas
taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker young allen king
wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter roberts gomez
phillips evans turner diaz parker cruz edwards collins reyes stewart morris morales murphy cook rogers gutierrez ortiz
morgan cooper peterson bailey reed kelly howard ramos kim cox ward richardson watson brooks chavez wood james bennett
gray mendoza ruiz hughes price alvarez castillo sanders patel myers long ross foster jimenez powell jenkins perry
russell sullivan bell coleman butler henderson barnes gonzales fisher vasquez simmons romero jordan patterson alexander
hamilton graham reynolds griffin wallace moreno west cole hayes bryant herrera gibson ellis tran medina aguilar stevens
murray ford castro marshall owens harrison fernandez mcdonald woods washington kennedy wells vargas henry chen freeman
webb tucker guzman burns crawford olson simpson porter hunter gordon mendez silva shaw snyder mason dixon munoz hunt
hicks holmes palmer wagner black robertson boyd rose stone salazar fox warren mills meyer rice schmidt garza daniels
ferguson nichols stephens soto weaver ryan gardner payne grant dunn kelley spencer hawkins arnold pierce vazquez hansen
peters santos hart bradley knight elliott cunningham duncan armstrong hudson carroll lane riley andrews alvarado ray
delgado berry perkins hoffman johnston matthews pena richards contreras willis carpenter lawrence sandoval guerrero
george chapman rios estrada ortega watkins greene nunez wheeler valdez harper burke larson santiago maldonado morrison
franklin carlson austin dominguez carr lawson jacobs obrien lynch singh vega bishop montgomery oliver jensen harvey
williamson gilbert dean sims espinoza howell li wong reid hanson le mccoy garrett burton fuller wang weber welch rojas
lucas marquez fields park yang little banks padilla day walsh bowman schultz luna fowler mejia davidson acosta brewer
may holland juarez newman pearson curtis cortez douglas schneider joseph barrett navarro figueroa keller avila wade
molina stanley hopkins campos barnett bates chambers caldwell beck lambert miranda byrd craig ayala lowe frazier powers
neal leonard gregory carrillo sutton fleming rhodes shelton schwartz norris jennings watts duran walters cohen mcdaniel
moran parks steele vaughn becker holt deleon barker terry hale leon hail benson haynes horton miles lyons pham graves
bush thornton wolfe warner cabrera mckinney mann zimmerman dawson lara fletcher page mccarthy love robles cervantes
solis erickson reeves chang klein salinas fuentes baldwin daniel simon velasquez hardy higgins aguirre lin cummings
chandler sharp barber bowen ochoa dennis robbins liu ramsey francis griffith paul blair oconnor cardenas pacheco cross
calderon quinn moss swanson chan rivas khan rodgers serrano fitzgerald rosales stevenson christensen manning gill curry
mclaughlin harmon mcgee gross doyle garner newton burgess reese walton blake trujillo adkins brady goodman roman webster
goodwin fischer huang potter delacruz montoya todd wu hines mullins castaneda malone cannon tate mack sherman hubbard
hodges zhang guerra wolf valencia saunders franco rowe gallagher farmer hammond hampton townsend ingram wise gallegos
clarke barton schroeder maxwell waters logan camacho strickland norman person colon parsons frank harrington glover
osborne buchanan casey floyd patton ibarra ball tyler suarez bowers orozco salas cobb gibbs andrade bauer conner moody
escobar mcguire lloyd mueller hartman french kramer mcbride pope lindsey velazquez norton mccormick sparks flynn yates
hogan marsh macias villanueva zamora pratt stokes owen ballard lang brock villarreal charles drake barrera cain patrick
pineda burnett mercado santana shepherd bautista ali shaffer lamb trevino mckenzie hess beil olsen cochran morton nash
wilkins petersen briggs shah roth nicholson holloway lozano flowers rangel hoover arias short mora valenzuela bryan
meyers weiss underwood bass greer summers houston carson morrow clayton whitaker decker yoder collier zuniga carey
wilcox melendez poole roberson larsen conley davenport copeland massey lam huff rocha cameron jefferson hood monroe
anthony pittman huynh randall singleton kirk combs mathis christian skinner bradford richard galvan wall boone kirby
wilkinson bridges bruce atkinson velez meza roy vincent york hodge villa abbott allison tapia gates chase sosa sweeney
farrell wyatt dalton horn barron phelps yu dickerson heath foley atkins mathews bonilla acevedo benitez zavala hensley
glenn cisneros harrell shields rubio choi huffman boyer garrison arroyo bond kane hancock callahan dillon cline wiggins
grimes arellano melton oneill savage ho beltran pitts parrish ponce rich booth koch golden ware brennan mcdowell marks
cantu humphrey baxter sawyer clay tanner hutchinson kaur berg wiley gilmore russo villegas hobbs keith wilkerson ahmed
beard mcclain montes mata rosario vang walter henson oneal mosley mcclure beasley stephenson snow huerta preston vance
barry johns eaton blackwell dyer prince macdonald solomon guevara stafford english hurst woodard cortes shannon kemp
nolan mccullough merritt murillo moon salgado strong kline cordova barajas roach rosas winters jacobson lester knox
bullock kerr leach meadows davila orr whitehead pruitt kent conway mckee barr david dejesus marin berger mcintyre
blankenship gaines palacios cuevas bartlett durham dorsey mccall odonnell stein browning stout lowery sloan mclean
hendricks calhoun sexton chung gentry hull duarte ellison nielsen gillespie buck middleton sellers leblanc esparza
hardin bradshaw mcintosh howe livingston frost glass morse knapp herman stark bravo noble spears weeks corona
frederick buckley mcfarland hebert enriquez hickman quintero randolph schaefer walls trejo house reilly pennington
michael conrad giles benjamin crosby fitzpatrick donovan mays mahoney valentine raymond medrano hahn mcmillan small
bentley felix peck lucero boyle hanna pace rush hurley harding mcconnell bernal nava ayers everett ventura avery pugh
mayer bender shepard mcmahon landry case sampson moses magana blackburn dunlap gould duffy vaughan herring mckay espinosa
rivers farley bernard ashley friedman potts truong costa correa blevins nixon clements fry delarosa best benton lugo
portillo dougherty crane haley phan villalobos blanchard horne finley quintana lynn esquivel bean dodson mullen xiong
hayden cano levy huber richmond moyer lim frye sheppard mccarty avalos booker waller parra woodward jaramillo krueger
rasmussen brandt peralta donaldson stuart faulkner maynard galindo coffey estes sanford burch maddox vo oconnell vu
andersen spence mcpherson church schmitt stanton leal cherry compton dudley sierra pollard alfaro hester proctor lu
hinton novak good madden mccann terrell jarvis dickson reyna cantrell mayo branch hendrix rollins rowland whitney duke
odom daugherty travis tang archer
`.split(/\s+/).filter(Boolean));

const SPELL_QUESTION = 'Could you spell your last name for me?';
const SPELL_REASK = 'Sorry, could you spell that once more, one letter at a time?';

/** Is this a last name Ava should not trust her ears on? */
function needsSpelling(lastName) {
  const words = String(lastName || '').toLowerCase().replace(/['’.]/g, '').split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return false;
  return !words.every((w) => COMMON_SURNAMES.has(w));
}

// How a transcriber may write a letter that was said aloud.
const LETTER_SOUNDS = {
  ay: 'a', bee: 'b', be: 'b', see: 'c', sea: 'c', cee: 'c', dee: 'd', ee: 'e', eff: 'f', ef: 'f', gee: 'g', aitch: 'h', eye: 'i',
  jay: 'j', kay: 'k', el: 'l', elle: 'l', em: 'm', en: 'n', oh: 'o', pee: 'p', pea: 'p', cue: 'q', queue: 'q', are: 'r', ar: 'r',
  ess: 's', es: 's', tee: 't', tea: 't', you: 'u', vee: 'v', ex: 'x', why: 'y', zee: 'z', zed: 'z',
};
const FILLER = new Set(['sure', 'yeah', 'yes', 'yep', 'okay', 'ok', 'um', 'uh', 'so', 'well', 'no', 'not', 'sorry', 'actually', "it's", 'its', 'it', 'is', "that's", 'thats', 'that',
  'spelled', 'spelt', 'spell', 'the', 'my', 'last', 'name', 'and', 'then', 'capital', 'lowercase', 'letter', 'letters', 'with', 'a']);

/** "mcdonald" -> "McDonald", "o'brien" -> "O'Brien", "van cauwenberge" -> "Van Cauwenberge". */
function formatName(s) {
  return s.replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`);
}

/**
 * Read a spelled-out name: "I Y E R", "I-Y-E-R", "B as in boy, A, K, E, R", "double L", "V A N space C A U ...".
 * Returns the name as written, or null when the turn is not plainly a spelling (the model reads it then).
 * `heard` is the name as first transcribed: it shows where a space goes when the caller did not say "space".
 */
function parseSpelling(text, heard = '') {
  const raw = String(text || '').replace(/[‘’]/g, "'");
  if (!raw.trim() || /\?/.test(raw)) return null;
  // "I-Y-E-R" and "I.Y.E.R." are letters; "new word" is a space.
  const tokens = raw.replace(/\bnew word\b/gi, ' space ').replace(/\bdouble[- ]u\b/gi, ' w ').replace(/[.,;:!\-–—/]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  const unknown = []; // { at: index in out, word }
  let plainLetters = 0;
  let sounds = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const w = tok.toLowerCase();
    const next = (tokens[i + 1] || '').toLowerCase();
    const single = (x) => /^[a-z]$/.test(x) || /^[a-z]'s$/.test(x);
    if (w === 'space') { out.push(' '); continue; }
    if (w === 'apostrophe') { out.push("'"); continue; }
    if (w === 'hyphen' || w === 'dash') { out.push('-'); continue; }
    if ((w === 'double' || w === 'two') && single(next)) { out.push(next[0], next[0]); plainLetters += 2; i++; continue; }
    if (single(w)) {
      // "I" and "A" start sentences too: they count as letters only next to other letters.
      const isWordToo = w === 'i' || w === 'a';
      const nextIsLetter = single(next) || next === 'as' || next === 'like' || next === 'space' || next === 'double';
      const prevWasLetter = out.length > 0 && unknown.every((u) => u.at < out.length);
      if (isWordToo && !nextIsLetter && !(prevWasLetter && plainLetters > 0)) { if (FILLER.has(w)) continue; unknown.push({ at: out.length, word: w }); continue; }
      out.push(w[0]);
      plainLetters++;
      // "B as in boy" / "B like boy" / "B for boy"
      if (next === 'as' && (tokens[i + 2] || '').toLowerCase() === 'in' && tokens[i + 3]) i += 3;
      else if ((next === 'like' || next === 'for') && tokens[i + 2]) i += 2;
      continue;
    }
    // "IYER" / "VAN": letters the transcriber wrote as one block.
    if (/^[A-Z]{2,}$/.test(tok) && tokens.length <= 6) { out.push(...w.split('')); plainLetters += w.length; continue; }
    if (FILLER.has(w)) continue;
    if (LETTER_SOUNDS[w]) { out.push(LETTER_SOUNDS[w]); sounds++; continue; }
    unknown.push({ at: out.length, word: w });
  }
  const letters = out.filter((c) => /[a-z]/.test(c)).length;
  // The name said whole before or after the letters is fine ("Iyer, I Y E R"); words in the middle are not a spelling.
  if (unknown.some((u) => u.at > 0 && u.at < out.length) || unknown.length > 3) return null;
  if (letters < 2 || plainLetters < 2 || (sounds > 0 && plainLetters < sounds)) return null;
  let name = out.join('').replace(/\s+/g, ' ').replace(/^[\s'-]+|[\s-]+$/g, '');
  if (!name) return null;
  // "Van Cowenberg" heard, "vancauwenberge" spelled: the space goes where the heard name had it.
  const heardWords = String(heard || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!/\s/.test(name) && heardWords.length > 1) {
    let rest = name;
    const lead = [];
    for (const hw of heardWords.slice(0, -1)) {
      const plain = hw.replace(/[^a-z]/g, '');
      if (plain && rest.startsWith(plain) && rest.length > plain.length + 1) { lead.push(plain); rest = rest.slice(plain.length); } else break;
    }
    if (lead.length) name = `${lead.join(' ')} ${rest}`;
  }
  return formatName(name);
}

/** Did the caller already spell this name in the same breath ("Iyer, I Y E R")? */
function spelledIn(text, lastName) {
  const want = String(lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (want.length < 2) return false;
  const tokens = String(text || '').replace(/[.,;:!\-–—/]+/g, ' ').split(/\s+/).filter(Boolean);
  let run = '';
  const runs = [];
  for (const tok of tokens) {
    if (/^[a-zA-Z]$/.test(tok)) run += tok.toLowerCase();
    else if (/^(space|double|as|in|like)$/i.test(tok)) continue;
    else { if (run.length >= 3) runs.push(run); run = ''; }
  }
  if (run.length >= 3) runs.push(run);
  return runs.some((r) => r === want || want.endsWith(r));
}

/** "Van Cowenberg" and "Van Cauwenberge", "Ayar" and "Iyer": the same name as the transcriber hears it. */
function soundsAlike(a, b) {
  const x = String(a || '').toLowerCase().replace(/[^a-z]/g, '');
  const y = String(b || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!x || !y) return false;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length) >= 0.5;
}

/**
 * "No, it is N, W, O, S, U. My phone number is 973-555-0155.": the spelling, and what came after it.
 * Returns { name, rest } or null.
 */
function leadingSpelling(text, heard = '') {
  const raw = String(text || '').trim();
  const whole = parseSpelling(raw, heard);
  if (whole) return { name: whole, rest: '' };
  const parts = raw.split(/(?<=[.!])\s+(?=[A-Z][a-z'’])/);
  for (let n = parts.length - 1; n >= 1; n--) {
    const name = parseSpelling(parts.slice(0, n).join(' '), heard);
    if (name) return { name, rest: parts.slice(n).join(' ') };
  }
  return null;
}

/** How Ava says it back: "I, Y, E, R". */
function lettersLine(name) {
  return String(name || '').split('').map((c) => (c === ' ' ? 'space' : c === "'" ? 'apostrophe' : c === '-' ? 'dash' : c.toUpperCase())).join(', ');
}

module.exports = { COMMON_SURNAMES, SPELL_QUESTION, SPELL_REASK, needsSpelling, parseSpelling, leadingSpelling, soundsAlike, spelledIn, lettersLine, formatName };
