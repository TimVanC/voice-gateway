/**
 * The relay brain (src/relay-brain.js) with a scripted turn reader in place of
 * the model, so every rule the brain enforces is checked the same way every
 * time: what gets stored, what is refused, when the call ends or transfers.
 *
 *   node src/test-relay-brain.js
 */
const { createRelayBrain, grounding, titleName, spelledEmail } = require('./relay-brain');
const { SAFETY, CLOSE } = require('./scripts/rse-script');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     got      ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`}`);
}
const has = (text, part) => String(text || '').includes(part);

/** A brain whose model answers are scripted: reads[i] is returned for the i-th turn that reaches the model. */
function brainWith(reads, callerNumber = '+19735550100') {
  let i = 0;
  const extractor = { name: 'scripted', extract: async () => { const r = reads[i++]; if (!r) throw new Error('no scripted read left'); if (r instanceof Error) throw r; return { fields: [], flags: [], reply: '', ...r }; } };
  const brain = createRelayBrain({ extractor, callerNumber, log: () => {} });
  return { brain, used: () => i };
}
const f = (k, v) => ({ k, v });

(async () => {
  console.log('🧪 A plain no-heat call: nothing asked twice, read-back, goodbye');
  {
    const { brain, used } = brainWith([
      { fields: [f('intent', 'hvac_service'), f('system_type', 'furnace'), f('symptoms', 'no heat'), f('start_time', 'this morning'), f('severity', 'completely out')] },
      { fields: [f('email', 'maria@example.com')] },
      { fields: [f('street', '14 Elm Street'), f('city', 'Montclair'), f('state', 'NJ'), f('zip', '07042')] },
      { fields: [f('availability', 'weekday mornings')] },
    ]);
    let o = await brain.handle("Hi, my furnace stopped working this morning and there's no heat at all, it's completely out.");
    check('first reply is the safety question', has(o.say, 'any smoke, gas smell, or sparks'), true);
    o = await brain.handle("No, there's no smoke, gas smell, or sparks.");
    check('a denial that repeats the words is all clear', has(o.say, 'first and last name'), true);
    o = await brain.handle('Maria Lopez.');
    check('then the phone', has(o.say, 'phone number'), true);
    o = await brain.handle("It's 973-555-0142.");
    check('a plain name and ten digits need no model call (1 read so far)', used(), 1);
    check('then the email', has(o.say, 'email'), true);
    o = await brain.handle('maria at example dot com');
    check('system, symptoms, start and severity were given up front: straight to the address', has(o.say, 'service address'), true);
    o = await brain.handle('14 Elm Street, Montclair, New Jersey 07042.');
    check('then availability', has(o.say, 'days and times'), true);
    o = await brain.handle('Weekday mornings.');
    check('then the read-back', o.recap === true && has(o.say, 'Name: Maria Lopez.') && has(o.say, 'Phone: 973-555-0142.') && has(o.say, 'Address: 14 Elm Street, Montclair, New Jersey 07042.'), true);
    check('issue is not doubled', has(o.say, 'System: furnace. Issue: no heat, completely out.'), true);
    o = await brain.handle("Yes, that's all correct.");
    check('yes moves to anything else', o.say, CLOSE.anything_else);
    o = await brain.handle("No, that's it, thank you.");
    check('and the goodbye ends the call', [o.say, o.end], [CLOSE.goodbye, true]);
    const d = brain.getData();
    check('stored fields', [d.intent, d.firstName, d.lastName, d.phone, d.email, d.address, d.city, d.state, d.zip, d.availability], ['hvac_service', 'Maria', 'Lopez', '973-555-0142', 'maria@example.com', '14 Elm Street', 'Montclair', 'NJ', '07042', 'weekday mornings']);
    check('office summary', d._brainSummary, 'Furnace: no heat; completely out; started this morning.');
    check('details confirmed', d._detailsConfirmed, true);
  }

  console.log('\n🧪 Only what the caller said is stored');
  {
    const { brain } = brainWith([
      { fields: [f('intent', 'hvac_service'), f('system_type', 'furnace'), f('symptoms', 'not heating well'), f('severity', 'still running'), f('system_age', 'about 25 years'), f('first_name', 'David')] },
    ]);
    await brain.handle('Hi, my furnace is not heating well, it was here when we bought the place in ninety eight.');
    const d = brain.getData();
    check('severity nobody stated is dropped', d.details.severity, null);
    check('an age worked out from a year is dropped', d.details.systemAge, null);
    check('a first name nobody said is dropped', d.firstName, null);
    check('what was said is kept', [d.details.systemType, d.details.symptoms], ['furnace', 'not heating well']);
  }
  {
    const g = grounding('my email is david cohen at example dot com');
    check('a name inside an email address is not a spoken name', g.name('David'), false);
    check('a spelled name is found', grounding('V A N space C A U W E N B E R G E').name('Van Cauwenberge'), true);
    check('title case for a lower-case name', titleName("kevin o'brien"), "Kevin O'Brien");
    check('email spelled after a correction', spelledEmail('j_tran88@protonmail.com'), 'j, underscore, t, r, a, n, 8, 8, at protonmail dot com');
  }

  console.log('\n🧪 Corrections at the read-back');
  {
    const { brain } = brainWith([
      { fields: [f('intent', 'hvac_service'), f('system_type', 'central air'), f('symptoms', 'not cooling'), f('start_time', 'on Sunday'), f('severity', 'still running')] },
      { flags: ['no_email'] },
      { fields: [f('street', '18 Cedar Lane'), f('city', 'Summit'), f('zip', '07901')] },
      { fields: [f('availability', 'Friday mornings')] },
      { fields: [f('phone', '9735550175')] },
    ]);
    await brain.handle("My central air isn't cooling since Sunday, it's still running though.");
    await brain.handle('No.');
    await brain.handle('Nina Alvarez.');
    await brain.handle('973-555-0115.');
    await brain.handle("I don't have one.");
    await brain.handle('18 Cedar Lane, Summit, 07901.');
    let o = await brain.handle('Friday mornings.');
    check('read-back reached', o.recap, true);
    o = await brain.handle('Actually the phone number is wrong, it should be 973-555-0175.');
    check('only the fixed item is read back', o.say, 'Got it. The phone is 973-555-0175. Is everything else correct?');
    check('and it is stored', brain.getData().phone, '973-555-0175');
    o = await brain.handle('Yes.');
    check('then anything else', o.say, CLOSE.anything_else);
  }

  console.log('\n🧪 Safety');
  {
    const { brain } = brainWith([{ fields: [f('intent', 'hvac_service')] }, { flags: ['hazard_now'] }]);
    await brain.handle('My furnace went out.');
    const o = await brain.handle('Yes, I do smell gas down there.');
    check('gas smell ends the call with the 911 line', [o.say, o.end], [SAFETY.emergency_response, true]);
    check('and is marked as a safety risk', brain.getData().isSafetyRisk, true);
  }
  {
    const { brain } = brainWith([{ fields: [f('intent', 'hvac_service')] }, { flags: ['hazard_unsure'] }]);
    await brain.handle("My furnace won't ignite.");
    let o = await brain.handle("Well, there was kind of a burning smell earlier, but it's gone now.");
    check('a hedged answer gets one plain follow-up, not 911', o.say, 'Just to be safe, is there any smoke, gas smell, or sparks right now?');
    o = await brain.handle('No, nothing right now.');
    check('a clear no then carries on', has(o.say, 'first and last name'), true);
    check('and the office sees the mention', brain.getData()._brainSummary.includes('possible hazard mentioned'), true);
  }
  {
    const { brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'not heating well')] }, { flags: ['hazard_now'] }]);
    await brain.handle("My furnace isn't heating very well.");
    await brain.handle('No, nothing like that.');
    await brain.handle('Sharon Pike.');
    const o = await brain.handle('Hold on, the carbon monoxide alarm in the hallway just started beeping.');
    check('a carbon monoxide alarm later in the call still ends it with the 911 line', [o.say, o.end], [SAFETY.emergency_response, true]);
  }
  {
    const { brain } = brainWith([{ fields: [f('intent', 'hvac_service')], flags: ['hazard_now'] }]);
    const o = await brain.handle("My furnace is completely out and it's an emergency, we have no heat.");
    check('"completely out" and "emergency" are not a hazard', has(o.say, 'any smoke, gas smell, or sparks'), true);
  }

  console.log('\n🧪 Transfers, wrong numbers and hang-ups need the caller to say so');
  {
    const { brain } = brainWith([{ fields: [f('intent', 'membership')], flags: ['wants_human'], reply: 'The team will go over pricing.' }]);
    const o = await brain.handle('Hi, how much is your maintenance plan for a generator?');
    check('a price question is not a transfer, even if the model says so', o.transfer, undefined);
    check('and the plan price comes from the price list', has(o.say, 'The Generator Service Plan is $275 a year.'), true);
  }
  {
    const { brain } = brainWith([{ flags: [] }]);
    const o = await brain.handle('Can I just talk to a real person please?');
    check('asking for a person transfers', [o.say, o.transfer], ['Sure, one moment while I connect you.', true]);
  }
  {
    const { brain } = brainWith([]);
    const o = await brain.handle('Hello? Hello, is anybody there?');
    check('"is anybody there" is a greeting, not a transfer', [o.say, o.transfer], ['Hi there, what can I help you with today?', undefined]);
  }
  {
    const { brain } = brainWith([{ flags: ['cancel'] }]);
    const o = await brain.handle('My furnace is out, I need someone.');
    check('a cancel flag without the words does not end the call', o.end, undefined);
  }
  {
    const { brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'not cooling')] }, { flags: ['cancel'] }]);
    await brain.handle("My AC isn't cooling.");
    await brain.handle('No.');
    await brain.handle('Megan Doyle.');
    await brain.handle('973-555-0110.');
    const o = await brain.handle('You know what, never mind, my husband just got it working.');
    check('"never mind" ends without promising a call', [has(o.say, 'in touch'), o.end], [false, true]);
    check('and the call is not marked confirmed', brain.getData()._detailsConfirmed, false);
  }

  console.log('\n🧪 Waiting, repeating, silence');
  {
    const { brain, used } = brainWith([{ fields: [f('intent', 'hvac_service'), f('system_type', 'furnace'), f('symptoms', 'not heating')] }, { fields: [f('phone', '9735550187')] }]);
    await brain.handle("My furnace isn't heating the house.");
    await brain.handle('No.');
    let o = await brain.handle('Sure.');
    check('"Sure." before the answer: Ava waits', o, { wait: true });
    await brain.handle("It's Andre Mitchell.");
    o = await brain.handle("It's 973, uh, hold on.");
    check('"hold on": she says take your time', o.say, 'Sure, take your time.');
    o = await brain.handle('Sorry. 973-555-0187.');
    check('and the pieces are read together', brain.getData().phone, '973-555-0187');
    const n = used();
    o = await brain.handle('What was that, dear?');
    check('"what was that?" repeats the question without a model call', [has(o.say, 'email'), used()], [true, n]);
  }
  {
    const { brain } = brainWith([]);
    check('first silence after the greeting', brain.onSilence(1).say, 'Hi there, what can I help you with today?');
    check('second silence', has(brain.onSilence(2).say, "If you're there"), true);
    const o = brain.onSilence(3);
    check('third silence hangs up', [has(o.say, "I'll hang up for now"), o.end], [true, true]);
  }

  console.log('\n🧪 When the model is unreachable');
  {
    const { brain } = brainWith([new Error('timeout'), new Error('timeout'), new Error('timeout')]);
    let o = await brain.handle('My furnace is out.');
    check('the call carries on with patterns', typeof o.say, 'string');
    o = await brain.handle('Something else entirely.');
    o = await brain.handle('And again.');
    check('three failures in a row offer a transfer', has(o.say, 'transfer you to a team member'), true);
    o = await brain.handle('Yes please.');
    check('and yes takes it', o.transfer, true);
  }

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All relay-brain checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
