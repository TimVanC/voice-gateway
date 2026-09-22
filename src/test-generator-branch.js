// test-generator-branch.js - Walk a generator call through DETAILS_BRANCH
// Run: node src/test-generator-branch.js
//
// Regression for the existing/new question swap: after the caller answers
// "Is this for an existing generator or a new installation?", the detail
// question list changes and must restart from its first question.

const { createCallStateMachine } = require('./state/call-state-machine');
const { STATES, INTENT_TYPES, DETAILS, ADDRESS } = require('./scripts/rse-script');

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

function startGeneratorCall() {
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.GENERATOR);
  sm.transitionTo(STATES.DETAILS_BRANCH);
  return sm;
}

console.log('\n🧪 Generator branch: caller says EXISTING');
{
  const sm = startGeneratorCall();
  check('first question is existing-or-new', sm.getNextPrompt(), DETAILS.generator.existing_or_new);

  const r1 = sm.processInput('It is an existing generator');
  check('stays in details after existing/new answer', r1.nextState, STATES.DETAILS_BRANCH);
  check('generatorType stored as existing', sm.getData().details.generatorType, 'existing');
  check('next question is the issue question', r1.prompt.endsWith(DETAILS.generator.existing_issue), true);

  const r2 = sm.processInput("It won't start when the power goes out");
  check('issue answer stored', sm.getData().details.generatorIssue, "It won't start when the power goes out");
  check('moves to address after the issue question', r2.nextState, STATES.ADDRESS);
  check('asks for the address', r2.prompt.endsWith(ADDRESS.ask), true);
}

console.log('\n🧪 Generator branch: caller says NEW');
{
  const sm = startGeneratorCall();
  const r1 = sm.processInput('A new installation');
  check('generatorType stored as new', sm.getData().details.generatorType, 'new');
  check('next question is residential or commercial', r1.prompt.endsWith(DETAILS.generator.new_type), true);

  const r2 = sm.processInput('Residential');
  check('property type stored', sm.getData().details.propertyType, 'Residential');
  check('next question is brand preference', r2.prompt.endsWith(DETAILS.generator.new_brand), true);

  const r3 = sm.processInput('Exploring options');
  check('brand preference stored', sm.getData().details.brandPreference, 'Exploring options');
  check('moves to address after the brand question', r3.nextState, STATES.ADDRESS);
}

console.log('\n🧪 Generator branch: NEW already known from the greeting');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.GENERATOR);
  sm.updateDetail('generatorType', 'new');
  sm.transitionTo(STATES.DETAILS_BRANCH);
  check('skips existing-or-new, starts with residential or commercial', sm.getNextPrompt(), DETAILS.generator.new_type);

  const r1 = sm.processInput('Commercial');
  check('next question is brand preference', r1.prompt.endsWith(DETAILS.generator.new_brand), true);
  const r2 = sm.processInput('Generac');
  check('moves to address after the brand question', r2.nextState, STATES.ADDRESS);
}

console.log('\n🧪 Non-generator branch still advances one question at a time');
{
  const sm = createCallStateMachine();
  sm.setIntent(INTENT_TYPES.HVAC_SERVICE);
  sm.transitionTo(STATES.DETAILS_BRANCH);
  const r1 = sm.processInput('Central air');
  check('HVAC service: second question is symptoms', r1.prompt.endsWith(DETAILS.hvac_service.symptoms), true);
}

console.log(failures === 0 ? '\n✅ All generator branch checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
