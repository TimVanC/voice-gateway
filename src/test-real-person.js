/**
 * Who gets transferred to the office: callers who ask for a person, and only
 * them.
 *
 *   node src/test-real-person.js
 */
const { detectRealPersonRequest } = require('./utils/intent-classifier');

let failures = 0;
function check(text, expected, state) {
  const got = detectRealPersonRequest(text, state);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${expected ? 'TRANSFER' : 'stay    '}: "${text}"${state ? ` [${state}]` : ''}${ok ? '' : `  (got ${got})`}`);
}

console.log('🧪 Asking for a person');
check('Can I just talk to a real person please?', true);
check('I want to speak to someone.', true);
check('Let me talk to a human.', true);
check('Representative.', true);
check('Agent, please.', true);
check('Can you transfer me?', true);
check('You know what, can you just put me through to someone in the office?', true, 'email');
check('I need a manager.', true);
check("I don't want to talk to a computer.", true);
check('Is there a person I can talk to?', true);
check('Get me an operator.', true);
check('Can I speak to Ron?', true, 'greeting');
check('Is Zelda there?', true, 'greeting');
check('I would like a live agent.', true);
check('Could I speak with the owner?', true);

console.log('\n🧪 Not asking for a person');
check('Hello? Hello, is anybody there?', false, 'greeting');
check('Derek Shaw. Wait, am I talking to a real person or a computer?', false, 'name');
check('Are you a robot?', false);
check('My transfer switch is not working on the generator.', false);
check('A team member told me to call back.', false);
check('I need someone to come look at my furnace.', false, 'greeting');
check('Hi, this is Andrew Miller, my furnace is out.', false, 'greeting');
check("I'm Ron Davis, calling about my boiler.", false, 'greeting');
check('My real estate agent told me to call you.', false, 'details_branch');
check('Is this a real person?', false);
check('It is a human error on my part, the thermostat was off.', false);
check('No, nothing like that.', false);
check('The operator of the building is on site.', false, 'address');

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All real-person checks passed');
process.exit(failures ? 1 : 0);
