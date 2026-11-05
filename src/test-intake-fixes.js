// test-intake-fixes.js - Walk the no-heat intake (the daily smoke call's
// scenario) through the state machine and check the Nov 4 2026 fixes from
// the call-review tickets: accented names, system age, the zip follow-up,
// availability wording, the recap's issue line and the call summary.
// Run: node src/test-intake-fixes.js

const { createCallStateMachine } = require('./state/call-state-machine');
const { STATES, INTENT_TYPES, AVAILABILITY, CALLER_INFO } = require('./scripts/rse-script');
const { generateCallSummary } = require('./utils/google-sheets-logger');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    failures++;
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('\n🧪 No-heat intake: accented name, system age, zip declined, availability, recap, summary');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.NAME);

  const rName = sm.processInput("Sure, it's María López.");
  check('accented name accepted first time', rName.nextState, STATES.PHONE);
  check('first name stored in plain letters', sm.getData().firstName, 'Maria');
  check('last name stored in plain letters', sm.getData().lastName, 'Lopez');

  const rPhone = sm.processInput("It's 973-555-0142.");
  check('phone accepted', [STATES.EMAIL, STATES.PHONE].includes(rPhone.nextState), true);
  if (rPhone.nextState === STATES.PHONE) sm.processInput('Yes, that is right.');
  if (sm.getState() === STATES.EMAIL) {
    const rEmail = sm.processInput("It's maria at example dot com.");
    if (rEmail.nextState === STATES.EMAIL) sm.processInput('Yes.');
  }
  if (sm.getState() !== STATES.DETAILS_BRANCH) sm.transitionTo(STATES.DETAILS_BRANCH);

  sm.processInput("It's a gas furnace, about ten years old.");
  check('system type stored', sm.getData().details.systemType, 'furnace');
  check('system age stored from the system-type answer', sm.getData().details.systemAge, 'about 10 years');
  sm.processInput("It's completely out, no air at all coming through.");
  sm.processInput('It started this morning.');
  const rSev = sm.processInput("It's completely out.");
  check('details done, address asked', rSev.nextState, STATES.ADDRESS);

  let r = sm.processInput("Sure, it's 14 Elm Street, Montclair, New Jersey.");
  if (r.nextState === STATES.ADDRESS && /did you say/i.test(r.prompt || '')) r = sm.processInput("Yes, that's right, E-L-M Street.");
  check('zip follow-up asked once', /zip code/i.test(r.prompt || ''), true);
  r = sm.processInput("Oh, I don't have it on me right now.");
  check('declined zip moves on to availability', r.nextState, STATES.AVAILABILITY);
  check('availability question asked', (r.prompt || '').endsWith(AVAILABILITY.ask), true);
  check('address kept', sm.getData().address, '14 Elm Street');

  r = sm.processInput('Weekday mornings are best for me.');
  check('availability accepted without an extra read-back', r.nextState, STATES.CONFIRMATION);
  check('availability stored clean', sm.getData().availability, 'Weekday mornings');
  check('recap reads availability clean', (r.prompt || '').includes('Availability: Weekday mornings.'), true);
  check('recap reads the system with its age', (r.prompt || '').includes('System: furnace, about 10 years old.'), true);
  check('recap reads the issue whole', (r.prompt || '').includes('Issue: completely out, no air at all coming through.'), true);
  check('recap has no doubled period', /\.\./.test(r.prompt || ''), false);

  const summary = generateCallSummary(sm.getData(), 'complete');
  check('call summary is one clean sentence', summary.startsWith('Furnace, about 10 years old: completely out, no air at all coming through; started this morning.'), true);
}

console.log('\n🧪 Availability wording variants');
{
  const cases = [
    ['Weekday mornings work best for me.', 'Weekday mornings'],
    ['Um, probably weekday afternoons, I think.', 'Weekday afternoons'],
    ['Monday through Friday, 9 to 5 works for me', 'Monday through Friday, 9 to 5'],
    ['All right, let me know what else you need. I\'m available weekday mornings.', null],
  ];
  for (const [said, want] of cases) {
    const sm = createCallStateMachine();
    sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
    sm.transitionTo(STATES.NAME);
    sm.processInput('Tim Smith');
    sm.transitionTo(STATES.AVAILABILITY);
    const r = sm.processInput(said);
    const value = sm.getData().availability || (r.prompt || '').replace(/^I have (.*)\. Is that right\?$/, '$1');
    if (want) check(`"${said}" -> "${want}"`, value, want);
    else console.log(`   "${said}" -> ${JSON.stringify(value)} (${r.nextState})`);
  }
}

console.log('\n🧪 Recap issue line never cuts a word');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.NAME);
  sm.processInput('Tim Smith');
  sm.transitionTo(STATES.DETAILS_BRANCH);
  sm.processInput('A boiler, maybe twenty years old.');
  check('age qualifier does not make the system type uncertain', sm.getData().details.systemTypeUncertain, false);
  sm.processInput("Well, there's no heat at all, it's been banging and the pilot keeps going out since this morning and we have a baby in the house.");
  sm.processInput('This morning.');
  sm.processInput('Completely out.');
  check('age in words', sm.getData().details.systemAge, 'maybe 20 years');
  sm.transitionTo(STATES.AVAILABILITY);
  const r = sm.processInput('Anytime, we have no heat.');
  const issue = ((r.prompt || '').match(/Issue: ([^.]*)\./) || [])[1] || '';
  console.log(`   issue line: "${issue}"`);
  check('issue line has no ellipsis', issue.includes('...'), false);
  check('issue line ends on a whole word', /\w$/.test(issue), true);
  const summary = generateCallSummary(sm.getData(), 'complete');
  console.log(`   summary: "${summary}"`);
  check('summary names the boiler and its age', summary.startsWith('Boiler, maybe 20 years old:'), true);
}


console.log('\n🧪 A "yes" to a recap the caller did not hear is not a confirmation');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.NAME);
  sm.processInput('Tim Smith');
  sm.transitionTo(STATES.CONFIRMATION);
  const cut = sm.processInput("Yes, that's all correct.", { recapCutShort: true });
  check('recap read back again', cut.recapReplayed === true && cut.nextState === STATES.CONFIRMATION, true);
  check('replay is the full recap', /^Let me read that back\./.test(cut.prompt || ''), true);
  const corr = sm.processInput("No, the name is Tim Jones.", { recapCutShort: true });
  check('a correction during a cut recap is still a correction', corr.recapReplayed, undefined);
  const sm2 = createCallStateMachine();
  sm2.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm2.transitionTo(STATES.NAME);
  sm2.processInput('Tim Smith');
  sm2.transitionTo(STATES.CONFIRMATION);
  const ok = sm2.processInput("Yes, that's all correct.");
  check('a yes after a full recap moves on', ok.nextState !== STATES.CONFIRMATION || ok.recapReplayed !== true, true);
}

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All intake fix checks passed');
process.exit(failures ? 1 : 0);
