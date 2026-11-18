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

  console.log('\n🧪 Spelling the last name: asked only when the name is not a common one');
  {
    // A common name: no spelling question.
    let { brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }]);
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    let o = await brain.handle('John Smith.');
    check('Smith is not asked to spell', has(o.say, 'phone number') && !has(o.say, 'spell'), true);

    // A name the transcriber got wrong: asked once, the letters win, and they are read back.
    ({ brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }]));
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    o = await brain.handle('Priya Ayar.');
    check('an uncommon last name is asked to be spelled', has(o.say, 'Could you spell your last name'), true);
    check('the relay is told a spelling is pending', brain.slot(), 'name_spelling');
    o = await brain.handle('I, Y, E, R.');
    check('the letters are read back, then the phone question', has(o.say, "that's I, Y, E, R.") && has(o.say, 'phone number'), true);
    check('the spelled name is stored', brain.getData().lastName, 'Iyer');
    o = await brain.handle('No, it is I, Y, A, R.');
    check('a correction right after the read-back is taken', [brain.getData().lastName, has(o.say, "that's I, Y, A, R."), has(o.say, 'phone number')], ['Iyar', true, true]);
    o = await brain.handle('973-555-0142.');
    check('and the call carries on', has(o.say, 'email'), true);

    // Two words, spelled without saying "space": the space goes where it was heard.
    ({ brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }, { fields: [f('first_name', 'Tim'), f('last_name', 'Van Cowenberg')] }]));
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    o = await brain.handle("Yeah it's Tim, last name Van Cowenberg.");
    check('a two-word last name is asked to be spelled', has(o.say, 'Could you spell your last name'), true);
    o = await brain.handle('V as in Victor, A, N, C, A, U, W, E, N, B, E, R, G, E.');
    check('Van Cauwenberge', brain.getData().lastName, 'Van Cauwenberge');

    // Already spelled in the same breath: not asked again.
    ({ brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }, { fields: [f('first_name', 'Priya'), f('last_name', 'Iyer')] }]));
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    o = await brain.handle("It's Priya Iyer, that's I Y E R.");
    check('a name spelled up front is not asked about', has(o.say, 'phone number') && !has(o.say, 'spell'), true);

    // The caller will not spell it: asked twice at most, then a note for the office.
    ({ brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }, {}, {}]));
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    await brain.handle('Marek Wojciechowski.');
    o = await brain.handle('Just how it sounds.');
    check('asked once more', has(o.say, 'one letter at a time'), true);
    o = await brain.handle('I really could not tell you right now.');
    check('then Ava moves on', has(o.say, 'phone number'), true);
    check('the name as heard is kept', brain.getData().lastName, 'Wojciechowski');
    check('and the office is told', /last name was not spelled/.test(JSON.stringify(brain.getData())), true);

    // The model reads a spelling the pattern could not.
    ({ brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }, { fields: [f('last_name', 'Nwosu')] }]));
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    await brain.handle('Chidi Nosu.');
    o = await brain.handle('Okay so it starts with an N then W then O S U.');
    check('a spelling read by the model is stored', [brain.getData().lastName, has(o.say, "that's N, W, O, S, U.")], ['Nwosu', true]);
  }

  console.log('\n🧪 Spelling: a correction said with the next answer; a spelled name survives the read-back');
  {
    let { brain } = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'no heat')] }]);
    await brain.handle('My furnace has no heat.');
    await brain.handle('No, none of that.');
    await brain.handle('Chidi Nosu.');
    await brain.handle('N, W, O, S, O.');
    let o = await brain.handle('No, it is N, W, O, S, U. My phone number is 973-555-0155.');
    check('the fix and the phone number are both taken', [brain.getData().lastName, brain.getData().phone], ['Nwosu', '973-555-0155']);
    check('Ava says the letters once more and moves on', has(o.say, "Sorry, that's N, W, O, S, U.") && has(o.say, 'email'), true);

    ({ brain } = brainWith([
      { fields: [f('intent', 'membership')] },
      { fields: [f('first_name', 'Tim'), f('last_name', 'Van Cowenberg')] },
      { fields: [f('email', 'tim@example.com')] },
      { fields: [f('coverage_type', 'yearly')] },
      { fields: [f('system_count', '1')] },
      { fields: [f('street', '8 Orchard Road'), f('city', 'Chatham'), f('zip', '07928')] },
      { fields: [f('availability', 'Friday morning')] },
      { fields: [f('last_name', 'Van Cowenberg')] },
      { fields: [f('last_name', 'Smith')] },
    ]));
    await brain.handle('I want to sign up for the maintenance plan.');
    await brain.handle('Tim, last name Van Cowenberg.');
    await brain.handle('V, A, N, space, C, A, U, W, E, N, B, E, R, G, E.');
    await brain.handle('973-555-0119.');
    await brain.handle('tim at example dot com');
    await brain.handle('Yearly billing please.');
    await brain.handle('Just the one system.');
    await brain.handle('8 Orchard Road, Chatham, 07928.');
    o = await brain.handle('Friday morning.');
    check('the read-back has the spelled name', has(o.say, 'Name: Tim Van Cauwenberge.'), true);
    o = await brain.handle('The last name is Van Cowenberg.');
    check('the name said aloud again does not replace the spelling', brain.getData().lastName, 'Van Cauwenberge');
    check('Ava says how she has it spelled', has(o.say, 'last name spelled V, A, N, space, C, A, U'), true);
    o = await brain.handle('Actually put it under Smith, my wife’s name.');
    check('a different name is still a correction', brain.getData().lastName, 'Smith');
  }

  console.log('\n🧪 An email said as words follows the spelled last name');
  {
    const { brain } = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'no cooling')] },
      { fields: [f('first_name', 'Ramesh'), f('last_name', 'Iyer')] },
      { fields: [f('email', 'ramesh.ayer@example.com')] },
    ]);
    await brain.handle('My AC is not cooling.');
    await brain.handle('No, none of that.');
    await brain.handle('My first name is Ramesh, and the last name is Iyer. I, Y, E, R.');
    await brain.handle('973-555-0211.');
    await brain.handle('The email is ramesh dot ayer at example dot com.');
    check('the email takes the spelled last name', brain.getData().email, 'ramesh.iyer@example.com');
    const { alignEmailToName } = require('./name-spelling');
    check('an initial plus the name is left alone', alignEmailToName('mlopez@example.com', ['Lopez']), 'mlopez@example.com');
    check('an unrelated address is left alone', alignEmailToName('sales@acme.com', ['Ames']), 'sales@acme.com');
  }

  console.log('\n🧪 An email Ava cannot trust as heard is spelled by the caller');
  {
    const { emailIsPlain, parseEmailSpelling } = require('./email-spelling');
    check('everyday names are not asked about', emailIsPlain('john.smith@gmail.com', 'john dot smith at gmail dot com'), true);
    check('an initial and a common surname are not asked about', emailIsPlain('j_tran88@protonmail.com', 'j underscore tran eighty eight at proton mail dot com'), true);
    check('two names run together are not asked about', emailIsPlain('marialopez@example.com', 'maria lopez at example dot com'), true);
    check('an unusual name said as a word is asked about', emailIsPlain('ramish.ayer@example.com', 'ramish dot ayer at example dot com'), false);
    check('an unusual name already spelled is not asked about', emailIsPlain('dkowalski@example.com', 'd k o w a l s k i at example dot com'), true);
    check('the spelled last name is trusted', emailIsPlain('priya.iyer@example.com', 'priya dot iyer at example dot com', 'Iyer'), false);
    check('the spelled last name with a common first name is trusted', emailIsPlain('maria.iyer@example.com', 'maria dot iyer at example dot com', 'Iyer'), true);
    check('letters and a dot', parseEmailSpelling('R, A, M, E, S, H, dot, I, Y, E, R.', 'ramish.ayer@example.com'), 'ramesh.iyer');
    check('spelled straight through keeps the dot where it was heard', parseEmailSpelling('Sure. R A M E S H I Y E R.', 'ramish.ayer@example.com'), 'ramesh.iyer');
    check('only the hard part spelled', parseEmailSpelling('I, Y, E, R.', 'ramesh.ayer@example.com'), 'ramesh.iyer');
    check('a word next to its own spelling, and digits', parseEmailSpelling('D as in dog, Kowalski, K-O-W-A-L-S-K-I, seven two.', 'dkowalsky72@example.com'), 'dkowalski72');
    check('the whole address spelled: the part before the at', parseEmailSpelling('r-a-m-e-s-h dot i-y-e-r at example dot com', 'ramish.ayer@example.com'), 'ramesh.iyer');
    check('only the first part spelled: the rest of the address stays', parseEmailSpelling('R-A-M-E-S-H.', 'ramesh.iyer@example.com'), 'ramesh.iyer');
    check('only the first part spelled, and it was heard wrong', parseEmailSpelling('R, A, M, E, S, H.', 'ramish.iyer@example.com'), 'ramesh.iyer');
    check('a sentence is not a spelling', parseEmailSpelling('It is just how it sounds.', 'ramish.ayer@example.com'), null);

    const { brain } = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'no cooling')] },
      { fields: [f('first_name', 'Ramish'), f('last_name', 'Iyer')] },
      { fields: [f('email', 'ramish.ayer@example.com')] },
    ]);
    await brain.handle('My AC is not cooling.');
    await brain.handle('No, none of that.');
    await brain.handle('My first name is Ramish, and the last name is Iyer. I, Y, E, R.');
    await brain.handle('973-555-0211.');
    let o = await brain.handle('The email is ramish dot ayer at example dot com.');
    check('Ava asks for the spelling', has(o.say, 'spell the part before the at sign'), true);
    check('the relay is told an email spelling is pending', brain.slot(), 'email_spelling');
    o = await brain.handle('R, A, M, E, S, H, dot, I, Y, E, R.');
    check('the email is stored as spelled', brain.getData().email, 'ramesh.iyer@example.com');
    check('the first name follows the spelling', brain.getData().firstName, 'Ramesh');
    check('Ava thanks the caller and moves on', has(o.say, 'Thanks, got it.') && !has(o.say, 'spell'), true);
  }

  console.log('\n🧪 An everyday email is not spelled, and a caller who will not spell is not pressed');
  {
    const a = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'no cooling')] },
      { fields: [f('email', 'maria.lopez@gmail.com')] },
    ]);
    await a.brain.handle('My AC is not cooling.');
    await a.brain.handle('No, none of that.');
    await a.brain.handle('Maria Lopez.');
    await a.brain.handle('973-555-0211.');
    let o = await a.brain.handle('maria dot lopez at gmail dot com.');
    check('no spelling question for maria.lopez', has(o.say, 'spell'), false);

    const b = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'no cooling')] },
      { fields: [f('email', 'zbigniew@example.com')] },
      { fields: [], flags: ['unclear'] },
      { fields: [], flags: ['declined'] },
    ]);
    await b.brain.handle('My AC is not cooling.');
    await b.brain.handle('No, none of that.');
    await b.brain.handle('Maria Lopez.');
    await b.brain.handle('973-555-0211.');
    o = await b.brain.handle('zbigniew at example dot com.');
    check('an unusual address is asked about', has(o.say, 'spell the part before the at sign'), true);
    o = await b.brain.handle('It is just how it sounds.');
    o = await b.brain.handle('I would rather not.');
    check('Ava moves on', has(o.say, 'spell'), false);
    check('the email is kept as heard', b.brain.getData().email, 'zbigniew@example.com');
  }

  console.log('\n🧪 A caller who spells without being asked: the letters win, whatever the model read');
  {
    const { nameFromSpelling, spelledEmailIn, spellingRuns } = require('./unprompted-spelling');
    const TIM = 'Tim Van Cowenberg. V, A, N, C, A, U, W, E, N, B, E, R, G, E.';
    check('"Tim Van" + "Cowenberg" is put right', nameFromSpelling(TIM, 'Tim Van', 'Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('heard right, spelled straight through', nameFromSpelling(TIM, 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('nothing read by the model', nameFromSpelling(TIM, '', ''), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('only the hard word spelled', nameFromSpelling('Tim Van Cowenberg. C, A, U, W, E, N, B, E, R, G, E.', 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('letters written as capitals', nameFromSpelling('Tim Van Cowenberg. VAN CAUWENBERGE.', 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('hyphens between the letters', nameFromSpelling("It's Tim Van Cowenberg, that's V-A-N C-A-U-W-E-N-B-E-R-G-E.", 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('a letter written as a word', nameFromSpelling('Tim Van Cowenberg. V, A, N, C, A, you, W, E, N, B, E, R, G, E.', 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('a two-word first name stays whole', nameFromSpelling('Mary Ann Kovalchik, K, O, W, A, L, C, Z, Y, K.', 'Mary Ann', 'Kovalchik'), { first: 'Mary Ann', last: 'Kowalczyk', spelledLast: true });
    check('both names spelled', nameFromSpelling('Shavon Nguyen Okafor. First name is S, I, O, B, H, A, N. Last name N, G, U, Y, E, N, hyphen, O, K, A, F, O, R.', 'Shavon', 'Nguyen Okafor'), { first: 'Siobhan', last: 'Nguyen-Okafor', spelledLast: true });
    check('first name spelled, then the last', nameFromSpelling('My name is Tim, T-I-M, Van Cowenberg, V-A-N-C-A-U-W-E-N-B-E-R-G-E.', 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    check('an apostrophe', nameFromSpelling("Kevin O'Shaughnessy. O, apostrophe, S, H, A, U, G, H, N, E, S, S, Y.", 'Kevin', 'Oshawnessy'), { first: 'Kevin', last: "O'Shaughnessy", spelledLast: true });
    check('a spelling that has only begun changes nothing yet', nameFromSpelling('Tim Van Cowenberg. V, A, N.', 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cowenberg', spelledLast: false });
    check('the letters said twice are taken once', nameFromSpelling('Tim Van Cowenberg. C, A, U, W, E, N, B, E, R, G, E. C, A, U, W, E, N, B, E, R, G, E.', 'Tim', 'Van Cowenberg'), { first: 'Tim', last: 'Van Cauwenberge', spelledLast: true });
    {
      const { parseSpelling } = require('./name-spelling');
      check('asked to spell: the letters said twice are taken once', parseSpelling('V, A, N. C, A, U, W, E, N, B, E, R, G, E. C, A, U, W, E, N, B, E, R, G, E.', 'Van Cowenberg'), 'Van Cauwenberge');
      check('a name that repeats itself is left alone', parseSpelling('T, I, N, T, I, N.', 'Tintin'), 'Tintin');
      const p = brainWith([{ fields: [f('intent', 'hvac_service'), f('symptoms', 'leak')] }]);
      await p.brain.handle('My boiler is leaking.');
      await p.brain.handle('No, none of that.');
      await p.brain.handle('Tim Van Cowenberg.');
      await p.brain.handle('C, A, U, W, E, N, B, E, R, G, E.');
      check('asked to spell, only the hard word spelled: "Van" stays', p.brain.getData().lastName, 'Van Cauwenberge');
    }
    check('"my A C is out" is not a spelling', spellingRuns('Hi, my A C is out and the HVAC guy never came.').length, 0);
    check('no letters, nothing to do', nameFromSpelling('Maria Lopez.', 'Maria', 'Lopez'), null);

    check('an address spelled straight through', spelledEmailIn("It's T, V, A, N, C, A, U, W, E, N, B, E, R, G, E at gmail dot com."), 'tvancauwenberge@gmail.com');
    check('the word, then its letters', spelledEmailIn('Tim dot Van Cowenberg, V A N C A U W E N B E R G E, at gmail dot com.'), 'tim.vancauwenberge@gmail.com');
    check('letters, a dot and digits', spelledEmailIn('Sure, it is r a m e s h dot i y e r eight two at outlook dot com.'), 'ramesh.iyer82@outlook.com');
    check('"D as in dog"', spelledEmailIn('D as in dog, K, O, W, A, L, C, Z, Y, K, seven two, at gmail dot com.'), 'dkowalczyk72@gmail.com');
    check('letters in the part after the at', spelledEmailIn('S, I, O, B, H, A, N at okafor dash H, V, A, C dot com.'), 'siobhan@okafor-hvac.com');
    check('a pause before the at', spelledEmailIn('M, B, R, Z, E, Z, I, N, S, K, I. At comcast dot net.'), 'mbrzezinski@comcast.net');
    check('an address said as words is left to the reader', spelledEmailIn('maria dot lopez at gmail dot com'), null);

    // The model files "Tim Van" as the first name and keeps the heard surname: the letters still win.
    const a = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'rattling noise')] },
      { fields: [f('first_name', 'Tim Van'), f('last_name', 'Cowenberg')] },
    ]);
    await a.brain.handle('My furnace is making a rattling noise.');
    await a.brain.handle('No, none of that.');
    let o = await a.brain.handle(TIM);
    check('first name is Tim', a.brain.getData().firstName, 'Tim');
    check('last name is as spelled', a.brain.getData().lastName, 'Van Cauwenberge');
    check('Ava does not ask for a spelling she already has', has(o.say, 'spell'), false);
    check('Ava goes on to the phone number', has(o.say, 'phone number'), true);
    await a.brain.handle('973-555-0127.');
    // The address is spelled without being asked: no model read is left for this turn, and none is needed.
    o = await a.brain.handle("It's T, V, A, N, C, A, U, W, E, N, B, E, R, G, E at gmail dot com.");
    check('the email is as spelled', a.brain.getData().email, 'tvancauwenberge@gmail.com');
    check('Ava does not ask for the email again', has(o.say, 'spell') || has(o.say, 'email'), false);
    check('no model read was used for the spelled address', a.used(), 2);

    // The model reads a spelled address wrong: the letters still win.
    const b = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'rattling noise')] },
      { fields: [f('email', 'rameshiyer82@outlook.com'), f('availability', 'weekday mornings')] },
    ]);
    await b.brain.handle('My furnace is making a rattling noise.');
    await b.brain.handle('No, none of that.');
    await b.brain.handle('Maria Lopez.');
    await b.brain.handle('973-555-0127.');
    o = await b.brain.handle('Sure, it is r a m e s h dot i y e r eight two at outlook dot com. I am home weekday mornings.');
    check('the dot the model dropped is kept', b.brain.getData().email, 'ramesh.iyer82@outlook.com');
    check('no spelling question after a spelled address', has(o.say, 'spell'), false);
  }

  console.log('\n🧪 No spelling loop: asked at most twice, never again once spelled');
  {
    const reads = [{ fields: [f('intent', 'hvac_service'), f('symptoms', 'rattling noise')] }]; // the bare name needs no model read
    for (let n = 0; n < 12; n++) reads.push({ fields: [], flags: ['unclear'] });
    const a = brainWith(reads);
    await a.brain.handle('My furnace is making a rattling noise.');
    await a.brain.handle('No, none of that.');
    let asks = 0;
    let o = await a.brain.handle('Marek Voychekovski.');
    if (has(o.say, 'spell')) asks++;
    for (const said of ['Double you oh jay see eye.', 'Whoa, jeh, see, eye, eh.', 'Like I said.', 'Hello?']) {
      if (!has(o.say, 'spell')) break;
      o = await a.brain.handle(said);
      if (has(o.say, 'spell')) asks++;
    }
    check('the spelling is asked for at most twice', asks, 2);
    check('then Ava moves on', has(o.say, 'spell'), false);

    const b = brainWith([
      { fields: [f('intent', 'hvac_service'), f('symptoms', 'rattling noise')] },
      { fields: [f('first_name', 'Marek'), f('last_name', 'Voychekovski')] },
      { fields: [f('last_name', 'Voychekovski')] },
      { fields: [f('email', 'marek@example.com'), f('last_name', 'Voychekovski')] },
    ]);
    await b.brain.handle('My furnace is making a rattling noise.');
    await b.brain.handle('No, none of that.');
    o = await b.brain.handle('Marek Voychekovski.');
    check('an uncommon name is asked about once', has(o.say, 'spell your last name'), true);
    o = await b.brain.handle('W, O, J, C, I, E, C, H, O, W, S, K, I.');
    check('the spelling is taken', b.brain.getData().lastName, 'Wojciechowski');
    check('and not asked for again', has(o.say, 'spell your last name') || has(o.say, 'spell that'), false);
    o = await b.brain.handle('973-555-0127. That is Marek Voychekovski.');
    check('saying the name again does not bring the question back', has(o.say, 'spell your last name') || has(o.say, 'spell that'), false);
    check('the spelled name is kept', b.brain.getData().lastName, 'Wojciechowski');
  }

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All relay-brain checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
