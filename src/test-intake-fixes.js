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

console.log(failures === 0 ? '\n✅ All intake fix checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
