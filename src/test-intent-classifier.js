// test-intent-classifier.js - Keyword intent classification regressions
// Run: node src/test-intent-classifier.js
//
// Regression for the membership-vs-installation order: "what does your
// maintenance membership plan cost" carries price words, which used to lock
// hvac_installation_or_upgrade before the membership check ever ran. Also
// pins the clear yes/no detector used by the duplicate-transcript guard in
// CONFIRMATION/CLOSE.

const { classifyIntent } = require('./utils/intent-classifier');
const { isClearYesOrNo } = require('./utils/transcript-filters');
const { INTENT_TYPES } = require('./scripts/rse-script');

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

// classifyIntent expects lowercased text, as server-rse.js passes it.
const intent = (text) => classifyIntent(text.toLowerCase());

console.log('\n🧪 Membership wins over installation price words');
check('maintenance membership plans, what they cost',
  intent("Hi, I am calling about your maintenance membership plans, I would like to know what they cost."),
  INTENT_TYPES.MEMBERSHIP);
check('price of a maintenance membership plan',
  intent('I want to ask about the price of a maintenance membership plan for my home'),
  INTENT_TYPES.MEMBERSHIP);
check('quote for your service plan', intent('Can I get a quote for your service plan?'), INTENT_TYPES.MEMBERSHIP);
check('sign up for a new membership', intent("I'd like to sign up for a new membership"), INTENT_TYPES.MEMBERSHIP);
check('home comfort plan cost', intent('How much does the home comfort plan cost per month?'), INTENT_TYPES.MEMBERSHIP);
check('bare membership', intent("I'm calling about my membership"), INTENT_TYPES.MEMBERSHIP);

console.log('\n🧪 Installation and generator cases still classify as before');
check('new furnace quote', intent('I need a quote on a new furnace'), INTENT_TYPES.HVAC_INSTALLATION);
check('replace my AC', intent('I want to replace my AC unit'), INTENT_TYPES.HVAC_INSTALLATION);
check('how much does a heat pump cost', intent('How much does a heat pump cost to install?'), INTENT_TYPES.HVAC_INSTALLATION);
check('estimate for central air', intent('Looking for an estimate for central air'), INTENT_TYPES.HVAC_INSTALLATION);
check('new generator installed',
  intent('I want a new whole-house standby generator installed at my home'),
  { intent: INTENT_TYPES.GENERATOR, isNew: true });
check('generator price', intent('What is the price of a Generac generator?'), { intent: INTENT_TYPES.GENERATOR, isNew: true });
check('existing generator will not start', intent("My generator won't start"), INTENT_TYPES.GENERATOR);
check('generator maintenance plan stays generator',
  intent('Do you have a maintenance plan for my generator?'),
  INTENT_TYPES.GENERATOR);

console.log('\n🧪 Service and out-of-scope unchanged');
check('no heat', intent('I have no heat since this morning'), INTENT_TYPES.HVAC_SERVICE);
check('AC not working', intent('My AC is not working'), INTENT_TYPES.HVAC_SERVICE);
check('service keywords beat membership (member with a broken furnace)',
  intent("I'm a member and my furnace is broken"),
  INTENT_TYPES.HVAC_SERVICE);
check('solar', intent('I want a solar panel quote'), INTENT_TYPES.OUT_OF_SCOPE);
check('plumbing', intent('My water heater is leaking'), INTENT_TYPES.OUT_OF_SCOPE);
check('nothing matched', intent('Hello, is this RSE?'), null);

console.log('\n🧪 Clear yes/no detection for the duplicate-transcript guard');
for (const t of ['Yes.', "Yes, that's correct.", "Yes, that's right.", 'Yep, all correct', 'Yeah', 'Correct.',
                 'No, that\'s all.', "No, that's everything, thanks.", 'Nope', 'Nah', 'That’s correct']) {
  check(`accepts "${t}"`, isClearYesOrNo(t), true);
}
for (const t of ['Sorry, what was that?', 'Monday afternoons', 'I know the number', 'Now?', '', null]) {
  check(`rejects ${JSON.stringify(t)}`, isClearYesOrNo(t), false);
}

console.log(failures ? `\n❌ ${failures} failing check(s)` : '\n✅ All checks passed');
process.exit(failures ? 1 : 0);
