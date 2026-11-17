/**
 * The safety question ("any smoke, gas smell, or sparks right now?") and the
 * answers callers actually give. A wrong "yes" sends a customer with a dead
 * furnace to 911 and ends the call; a wrong "no" misses a gas leak.
 *
 *   node src/test-safety.js
 */
const { detectSafetyEmergency } = require('./state/call-state-machine');

let failures = 0;
function check(text, expected) {
  const got = detectSafetyEmergency(text.toLowerCase());
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${expected ? 'EMERGENCY' : 'all clear'}: "${text}"${ok ? '' : `  (got ${got})`}`);
}

console.log('🧪 Denials (the caller repeats the question\'s own words)');
check("No, there's no smoke, gas smell, or sparks.", false);
check('No smoke, gas smell, or sparks.', false);
check('No, nothing like that.', false);
check('Nope.', false);
check("No. I don't smell any gas and there's no smoke.", false);
check("There's no smoke, no gas smell, and no sparks.", false);
check("No, I haven't noticed any smoke, sparks or anything like that.", false);
check('Not that I can tell.', false);
check("No, it's just completely out.", false);
check("No, it's a total shutdown, nothing is running.", false);
check("No, but it's an emergency, we have no heat.", false);
check("No, it just won't fire up.", false);
check('No, nothing like that. It is a gas furnace though.', false);

console.log('\n🧪 Hazards');
check('Yes, I smell gas.', true);
check('I do smell gas down there.', true);
check("No smoke, but I do smell gas.", true);
check('No, I do smell gas.', true);
check("No smoke, there's a gas smell though.", true);
check('No smoke, a little gas smell.', true);
check("There's a gas smell, no smoke.", true);
check('There is smoke coming out of the unit.', true);
check('I saw some sparks a minute ago.', true);
check("Something's burning.", true);
check('I think it might be on fire.', true);
check('The carbon monoxide alarm is going off.', true);
check("I think there's a gas leak.", true);
check("Well, there was kind of a burning smell earlier, but it's gone now.", true);

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All safety checks passed');
process.exit(failures ? 1 : 0);
