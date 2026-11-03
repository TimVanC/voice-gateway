// test-intake-fixes.js - Regressions found by the bot-caller harness (Nov 2026)
// Run: node src/test-intake-fixes.js
//
// 1. Name missing at the recap: AVAILABILITY/CONFIRMATION asked for the name
//    but transitionTo() refused the backward move, so the call stayed in
//    CONFIRMATION, ignored the name and looped "Can I get your first and last
//    name?" / "Is everything correct?" until the caller hung up.
// 2. "Nothing like that" (the tail of the safety answer) was taken as a name.
// 3. "Thanks. I appreciate it." in ADDRESS was read as a goodbye and ended the call.

const { createCallStateMachine } = require('./state/call-state-machine');
const { STATES, INTENT_TYPES, CALLER_INFO, ADDRESS } = require('./scripts/rse-script');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    failures++;
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
  }
}

// A service call that reached AVAILABILITY without a name (the name was lost
// to a split turn), with phone and address already taken.
function callAtAvailabilityWithoutName() {
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.updateData('phone', '9735550142');
  sm.updateData('address', '14 Elm Street');
  sm.transitionTo(STATES.AVAILABILITY);
  return sm;
}

function answerAvailability(sm) {
  let r = sm.processInput('Weekday mornings are best for me.');
  if (r.nextState === STATES.AVAILABILITY) r = sm.processInput("Yes, that's correct.");
  return r;
}

console.log('\n🧪 Name missing before the recap: ask once, take it, return to the recap');
{
  const sm = callAtAvailabilityWithoutName();
  const r1 = answerAvailability(sm);
  check('moves to NAME', r1.nextState, STATES.NAME);
  check('state machine is really in NAME', sm.getState(), STATES.NAME);
  check('asks for the name', r1.prompt, CALLER_INFO.name);

  const r2 = sm.processInput("It's Maria Lopez.");
  check('name taken', [sm.getData().firstName, sm.getData().lastName], ['Maria', 'Lopez']);
  check('returns to the recap, not to PHONE', r2.nextState, STATES.CONFIRMATION);
  check('recap includes the name', /Maria Lopez/.test(r2.prompt), true);

  const r3 = sm.processInput("Yes, that's all correct.");
  check('recap confirmed: moves to CLOSE', r3.nextState, STATES.CLOSE);
}

console.log('\n🧪 Name missing when the recap is confirmed');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.updateData('phone', '9735550142');
  sm.transitionTo(STATES.CONFIRMATION);
  const r1 = sm.processInput('Yes, that is correct.');
  check('moves to NAME', [r1.nextState, sm.getState()], [STATES.NAME, STATES.NAME]);
  const r2 = sm.processInput('David Chen');
  check('returns to the recap', r2.nextState, STATES.CONFIRMATION);
  const r3 = sm.processInput('Yes.');
  check('then CLOSE', r3.nextState, STATES.CLOSE);
}

console.log('\n🧪 Only a first name: asked at most twice, then the call goes on');
{
  const sm = callAtAvailabilityWithoutName();
  answerAvailability(sm);
  let r = sm.processInput('Maria');
  for (let i = 0; i < 6 && r.nextState !== STATES.CLOSE; i++) {
    r = sm.processInput(r.nextState === STATES.NAME ? 'Maria' : "Yes, that's all correct.");
  }
  check('reaches CLOSE instead of looping', r.nextState, STATES.CLOSE);
}

console.log('\n🧪 Common words are not a name');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.NAME);
  for (const t of ['Nothing like that.', 'No, nothing like that.', 'Thanks. I appreciate it.', 'Not really, no.']) {
    const r = sm.processInput(t);
    check(`"${t}" -> stays in NAME and re-asks`, [r.nextState, r.prompt], [STATES.NAME, CALLER_INFO.name]);
  }
  check('no name stored', [sm.getData().firstName || null, sm.getData()._nameLocked || false], [null, false]);
  const r = sm.processInput("It's David Chen.");
  check('a real name is then taken', [r.nextState, sm.getData().firstName, sm.getData().lastName], [STATES.PHONE, 'David', 'Chen']);
}
// Names made of words that are also ordinary words still pass. (Particles such
// as "Van" / "de la" are dropped by the spelled-name path; that predates this
// fix and is not covered here.)
for (const [said, first, last] of [['Will Rose', 'Will', 'Rose'], ['Grace Hope', 'Grace', 'Hope'],
                                   ["Yeah, it's Maria Lopez", 'Maria', 'Lopez'], ['My name is David Chen', 'David', 'Chen']]) {
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.NAME);
  sm.processInput(said);
  const d = sm.getData();
  check(`"${said}" still accepted`, [d.firstName, d.lastName], [first, last]);
}

console.log('\n🧪 Safety check: a yes is an emergency, a backchannel is asked again');
{
  const { SAFETY } = require('./scripts/rse-script');
  const at = () => {
    const sm = createCallStateMachine();
    sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
    sm.transitionTo(STATES.SAFETY_CHECK);
    return sm;
  };
  for (const t of ['Yes.', 'Yeah, there is.', 'Yes, I smell something.', 'I think so.']) {
    const sm = at();
    const r = sm.processInput(t);
    check(`"${t}" -> emergency response`, [r.nextState, r.prompt, sm.getData().isSafetyRisk], [STATES.ENDED, SAFETY.emergency_response, true]);
  }
  for (const t of ['Mhm.', 'Okay.', 'Sure, go ahead.', 'Sorry, what was that?', 'Yes, go ahead.', 'Yeah, ask away.', 'Yes?']) {
    const sm = at();
    const r = sm.processInput(t);
    check(`"${t}" -> safety question asked again`, [r.nextState, r.prompt], [STATES.SAFETY_CHECK, SAFETY.check]);
    const r2 = sm.processInput('No, nothing like that.');
    check(`  then "No, nothing like that" -> name`, r2.nextState, STATES.NAME);
  }
  {
    const sm = at();
    sm.processInput('Mhm.');
    check('a second unclear reply moves on (asked once only)', sm.processInput('Okay.').nextState, STATES.NAME);
  }
  for (const t of ['No, nothing like that.', 'Nope.', 'Just no heat, nothing dangerous.', "No, it's just not heating."]) {
    check(`"${t}" -> all clear, name`, at().processInput(t).nextState, STATES.NAME);
  }
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.NAME);
  const r = sm.processInput('Sure, go ahead.');
  check('"Sure, go ahead." is not a name', [r.nextState, sm.getData().firstName || null], [STATES.NAME, null]);
}

console.log('\n🧪 House numbers written as words become digits (else the Sheet saves no address)');
{
  const { normalizeHouseNumber } = require('./utils/data-cleanup');
  for (const [said, want] of [['Fourteen Elm Street', '14 Elm Street'], ['Eighty-Eight Ridge Road', '88 Ridge Road'],
                              ['One twenty three Main St', '123 Main St'], ['Two hundred fifteen Oak Ave', '215 Oak Ave'],
                              ['14 Elm Street', '14 Elm Street'], ['Elm Street', 'Elm Street'], ['Fourteen', 'Fourteen']]) {
    check(`"${said}" -> "${want}"`, normalizeHouseNumber(said), want);
  }
}

console.log('\n🧪 "Thanks" in ADDRESS is not a goodbye');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.ADDRESS);
  for (const t of ['Thanks. I appreciate it.', 'Thank you so much.', 'Okay, thank you.']) {
    const r = sm.processInput(t);
    check(`"${t}" -> stays in ADDRESS and asks again`, [r.nextState, r.prompt, r.action], [STATES.ADDRESS, ADDRESS.ask, 'ask']);
  }
  const r = sm.processInput("It's 14 Elm Street, Montclair, New Jersey.");
  check('the address is then taken', r.nextState !== STATES.CLOSE && /14 Elm/i.test(sm.getData().address || ''), true);
}
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.ADDRESS);
  const r = sm.processInput('Never mind, goodbye.');
  check('an actual goodbye still ends the intake', [STATES.CLOSE, STATES.ENDED].includes(r.nextState), true);
}

console.log("\n🧪 Test-caller numbers never reach the Sheet; RSE's own number alone does not count");
{
  const { isTestCallerNumber, isOwnNumber } = require('./utils/call-db');
  const env = { TWILIO_NUMBER: '+18885842210', TEST_CALLER_NUMBERS: '+19735457975, 2015550177' };
  check('the smoke caller is a test number', isTestCallerNumber('+19735457975', env), true);
  check('a persona number is a test number (any formatting)', isTestCallerNumber('(201) 555-0177', env), true);
  check('a customer is not', isTestCallerNumber('+19735551234', env), false);
  check("RSE's own number is own but not a test caller", [isOwnNumber('+18885842210', env), isTestCallerNumber('+18885842210', env)], [true, false]);
  check('no number, no match', isTestCallerNumber(null, env), false);
}

console.log(failures === 0 ? '\n✅ All intake fix checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
