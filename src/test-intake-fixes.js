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

// Nov 3 2026, Neon call 2593: at the recap the model said "Is there anything
// else I can help with today?" instead of the read-back, the server accepted
// it, the caller answered "No, that's it. Thank you." and CONFIRMATION took
// that as a correction. The call never reached CLOSE and Ava never hung up.
console.log('\n🧪 Off-script lines at the recap and the close are rejected');
{
  const { transcriptMatchesExpected } = require('./utils/transcript-filters');
  const { CLOSE, CONFIRMATION } = require('./scripts/rse-script');
  const recap = "Let me read that back. Name: Maria Lopez. Phone: 973-555-0142. Email: maria at example dot com. Address: 14 Elm Street, Montclair, New Jersey. System: furnace. Issue: It's completely out. Availability: Weekday mornings are best for me.. Is everything correct?";
  check('"anything else?" is not the recap', transcriptMatchesExpected(recap, CLOSE.anything_else), false);
  check('the recap read back as written passes', transcriptMatchesExpected(recap, recap), true);
  check('the recap read back with the email and phone reworded passes',
    transcriptMatchesExpected(recap, 'Let me read that back. Name: Maria Lopez. Phone: 9735550142. Email: maria@example.com. Address: 14 Elm Street, Montclair, New Jersey. System: furnace. Issue: It\'s completely out. Availability: Weekday mornings are best for me. Is everything correct?'), true);
  check('an improvised wrap-up is not the recap',
    transcriptMatchesExpected(recap, "You're welcome. If anything else comes up, feel free to reach out. Have a great day!"), false);
  check('"Goodbye! Take care." is not "anything else?"', transcriptMatchesExpected(CLOSE.anything_else, 'Goodbye! Take care.'), false);
  check('"anything else?" said as written passes', transcriptMatchesExpected(CLOSE.anything_else, CLOSE.anything_else), true);
  check('"What needs to be corrected?" said as written passes', transcriptMatchesExpected('What needs to be corrected?', 'What needs to be corrected?'), true);
  check('"Is everything correct?" said as written passes', transcriptMatchesExpected(CONFIRMATION.verify, CONFIRMATION.verify), true);
}

console.log('\n🧪 At the recap, "No, that\'s it, thank you" means nothing to add: on to CLOSE');
{
  const { CLOSE } = require('./scripts/rse-script');
  const { isNothingElse } = require('./state/call-state-machine');
  const atRecap = () => {
    const sm = createCallStateMachine();
    sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
    sm.updateData('firstName', 'Maria'); sm.updateData('lastName', 'Lopez'); sm.updateData('_nameLocked', true);
    sm.updateData('phone', '9735550142');
    sm.updateData('address', '14 Elm Street');
    sm.transitionTo(STATES.CONFIRMATION);
    return sm;
  };
  for (const t of ["No, that's it. Thank you.", "No, that's all.", "Nope, that's everything, thanks.", "No, we're all set.", "No, I'm good, thank you.", "No, nothing else."]) {
    const sm = atRecap();
    const r = sm.processInput(t);
    check(`"${t}" -> CLOSE, asks anything else`, [r.nextState, r.prompt], [STATES.CLOSE, CLOSE.anything_else]);
  }
  for (const t of ["No.", "No, that's not right.", "No, the phone number is wrong.", "No, that's wrong, thanks.", "No, it's 973-555-0199, thanks.", "No, that's it, the address is wrong."]) {
    const sm = atRecap();
    const r = sm.processInput(t);
    check(`"${t}" -> stays at the recap and asks what to fix`, [r.nextState, r.prompt], [STATES.CONFIRMATION, 'What needs to be corrected?']);
    check(`  isNothingElse("${t}") is false`, isNothingElse(t), false);
  }
  {
    // A correction that names the field is applied and the recap re-read (existing behaviour).
    const r = atRecap().processInput('Actually, the email is wrong.');
    check('"Actually, the email is wrong." stays at the recap', [r.nextState, isNothingElse('Actually, the email is wrong.')], [STATES.CONFIRMATION, false]);
  }
  check('a plain yes still confirms', atRecap().processInput("Yes, that's all correct.").nextState, STATES.CLOSE);
  check('isNothingElse ignores empty input', isNothingElse(''), false);

  // Then CLOSE: the same words end the call, and Ava says goodbye.
  const sm = atRecap();
  sm.processInput("No, that's it. Thank you.");
  const r = sm.processInput("No, that's it, thank you.");
  check('in CLOSE, "No, that\'s it, thank you" -> ENDED with the goodbye', [r.nextState, r.prompt, r.action], [STATES.ENDED, CLOSE.goodbye, 'end_call']);
}

console.log('\n🧪 At the recap, a goodbye ends the call instead of re-asking "Is everything correct?"');
{
  const { CLOSE } = require('./scripts/rse-script');
  for (const t of ['Thanks, bye.', 'Okay, goodbye.', 'Bye.']) {
    const sm = createCallStateMachine();
    sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
    sm.updateData('firstName', 'Maria'); sm.updateData('lastName', 'Lopez'); sm.updateData('_nameLocked', true);
    sm.updateData('phone', '9735550142');
    sm.transitionTo(STATES.CONFIRMATION);
    const r = sm.processInput(t);
    check(`"${t}" -> ENDED with the goodbye`, [r.nextState, sm.getState(), r.prompt, r.action], [STATES.ENDED, STATES.ENDED, CLOSE.goodbye, 'end_call']);
  }
}

console.log('\n🧪 Dead-air watchdog holds while the caller\'s transcript is still pending (PR #17 run 3)');
{
  const { decideWatchdogAction, transcriptSupersedesRecovery, TRANSCRIPT_WAIT_CEILING_MS } = require('./utils/dead-air-watchdog');
  const base = {
    callCompleted: false, responseInProgress: false, speechActive: false,
    waitingForTranscription: false, transcriptWaitedMs: 0,
    isDeadAirRecovery: true, deadAirRecoveries: 0, maxDeadAirRecoveries: 3,
  };
  const decide = (o) => decideWatchdogAction({ ...base, ...o });

  // The 4 s "response_cancelled" recovery fires while transcription (median
  // 3.8 s, up to 4.1 s) is still running: hold for the rest of the ceiling.
  check('transcript pending 4 s after speech end -> hold, not a re-ask',
    decide({ waitingForTranscription: true, transcriptWaitedMs: 4000 }),
    { action: 'hold', reason: 'transcript_pending', holdMs: TRANSCRIPT_WAIT_CEILING_MS - 4000 });
  check('hold does not count as a recovery (no cap, even at the cap)',
    decide({ waitingForTranscription: true, transcriptWaitedMs: 4100, deadAirRecoveries: 3 }).action, 'hold');
  check('the ceiling is well above the 4 s recovery delay', TRANSCRIPT_WAIT_CEILING_MS >= 8000, true);

  // A transcript that never arrives still recovers once the ceiling passes.
  check('transcript still missing at the ceiling -> fallback, transcript abandoned',
    decide({ waitingForTranscription: true, transcriptWaitedMs: TRANSCRIPT_WAIT_CEILING_MS }),
    { action: 'fallback', reason: 'transcript_never_arrived', transcriptAbandoned: true });
  check('past the ceiling at the cap -> live-agent offer',
    decide({ waitingForTranscription: true, transcriptWaitedMs: TRANSCRIPT_WAIT_CEILING_MS + 1, deadAirRecoveries: 3 }).action, 'offer_transfer');

  // Behaviour without a pending transcript is unchanged.
  check('no transcript pending -> fallback as before',
    decide({}), { action: 'fallback', reason: 'dead_air', transcriptAbandoned: false });
  check('cap reached, nothing pending -> live-agent offer',
    decide({ deadAirRecoveries: 3 }).action, 'offer_transfer');
  check('speech_end watchdog (not a recovery) never offers a transfer',
    decide({ isDeadAirRecovery: false, deadAirRecoveries: 5 }).action, 'fallback');
  check('something already speaking -> skip', decide({ responseInProgress: true, waitingForTranscription: true }).action, 'skip');
  check('caller mid-speech -> skip', decide({ speechActive: true }).action, 'skip');
  check('call completed -> skip', decide({ callCompleted: true }).action, 'skip');

  // Run 3 as a sequence: three slow transcripts, each answered in 4.1 s.
  let recoveries = 0;
  const transfers = [];
  for (let turn = 0; turn < 3; turn++) {
    const d = decide({ waitingForTranscription: true, transcriptWaitedMs: 4000, deadAirRecoveries: recoveries });
    if (d.action === 'fallback') recoveries++;
    if (d.action === 'offer_transfer') transfers.push(turn);
  }
  check('three slow-transcript turns in one call: no recoveries counted, no transfer', [recoveries, transfers], [0, []]);

  // A late transcript that lands while the re-ask is playing cuts it off.
  check('transcript during the re-ask supersedes it',
    transcriptSupersedesRecovery({ recoveryPromptInFlight: true, hasActiveOutput: true, callCompleted: false, inEndedState: false }), true);
  check('no re-ask in flight -> nothing to cut',
    transcriptSupersedesRecovery({ recoveryPromptInFlight: false, hasActiveOutput: true, callCompleted: false, inEndedState: false }), false);
  check('re-ask already finished playing -> nothing to cut',
    transcriptSupersedesRecovery({ recoveryPromptInFlight: true, hasActiveOutput: false, callCompleted: false, inEndedState: false }), false);
  check('never cut the goodbye',
    transcriptSupersedesRecovery({ recoveryPromptInFlight: true, hasActiveOutput: true, callCompleted: false, inEndedState: true }), false);
}

console.log(failures === 0 ? '\n✅ All intake fix checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
