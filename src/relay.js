/**
 * Twilio ConversationRelay for Ava (RELAY=on, staging trial, Nov 2026).
 *
 * Twilio does the audio side: Deepgram Flux listens and decides when the
 * caller is done, ElevenLabs speaks (the voice in RELAY_VOICE), Twilio handles
 * interruptions and ignores "mm-hm" backchannels. Our WebSocket at /relay
 * receives each finished caller turn as text and sends Ava's reply as text.
 * Everything that made today's quirks (the audio pump, the prompt cache, the
 * TTS socket, barge-in grace, turn hold) is not involved.
 *
 * What runs here is the same script and state machine as the pipeline, with
 * the same free-form replies from the LLM. Calls are saved to Neon with their
 * transcript (no audio recording: Twilio keeps the audio).
 *
 *   TwiML:     relayTwiml({ host, callerNumber })          from POST /twilio/voice
 *   WebSocket: new RelaySession(ws, { llm })                 for wss://host/relay
 *   Hand-off:  relayEndedTwiml({ handoffData, callerNumber, transferNumber })  from the <Connect action>
 */

const { WebSocket } = require('ws');
const { createCallStateMachine } = require('./state/call-state-machine');
const { SYSTEM_PROMPT, GREETING, STATES, CLOSE, SAFETY, OUT_OF_SCOPE } = require('./scripts/rse-script');
const { classifyIntent, detectRealPersonRequest } = require('./utils/intent-classifier');
const { cleanCallData } = require('./utils/data-cleanup');
const { logCallIntake } = require('./utils/google-sheets-logger');
const { saveCall: saveCallToDb, createTranscriptRecorder } = require('./utils/call-db');
const { normalizeSpokenNumbers } = require('./pipeline/numbers');

// ElevenLabs voice string for Twilio: VOICE_ID-MODEL-SPEED_STABILITY_SIMILARITY
// (v3/v4 models take STABILITY_SIMILARITY only). Default: Eryn hyper-real on
// turbo v2.5 with the settings staging uses, so the first call compares like
// for like; RELAY_VOICE=kdnRe2koJdOK4Ovxn2DI-v4_turbo-0.65_0.75 tries v4.
const RELAY_VOICE = process.env.RELAY_VOICE || 'kdnRe2koJdOK4Ovxn2DI-turbo_v2_5-0.92_0.65_0.75';
const RELAY_EOT_THRESHOLD = process.env.RELAY_EOT_THRESHOLD || '0.7';
const RELAY_INTERRUPT_SENSITIVITY = process.env.RELAY_INTERRUPT_SENSITIVITY || 'medium';
const HINTS = 'Ava,RSE Energy,HVAC,mini split,ductless,heat pump,furnace,boiler,thermostat,generator,Generac,Cummins,maintenance plan,membership,New Jersey,Montclair,Madison,Morristown';
const GOODBYE_FAILSAFE_MS = 15000;
const BACKCHANNEL = /^(mm+-?hm+|mhm+|uh-?huh|yeah|yep|ok(ay)?|right|sure|got it|i see|alright|hm+)[.!?,]*$/i;
const TRANSFER_OFFER_PROMPT = "I'm sorry, it sounds like we're having a communication issue. I can transfer you to a live agent if you'd like. Would you like me to transfer you now?";
const SAME_PROMPT_LIMIT = 3;

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The TwiML that hands the call to ConversationRelay. */
function relayTwiml({ host, callerNumber }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="https://${host}/twilio/relay-ended">
    <ConversationRelay url="wss://${host}/relay"
      welcomeGreeting="${esc(GREETING.primary)}" welcomeGreetingInterruptible="speech"
      ttsProvider="ElevenLabs" voice="${esc(RELAY_VOICE)}"
      transcriptionProvider="Deepgram" speechModel="flux" eotThreshold="${esc(RELAY_EOT_THRESHOLD)}"
      interruptible="any" interruptSensitivity="${esc(RELAY_INTERRUPT_SENSITIVITY)}" ignoreBackchannel="true"
      dtmfDetection="true" hints="${esc(HINTS)}" events="tokens-played">
      <Parameter name="callerNumber" value="${esc(callerNumber)}" />
    </ConversationRelay>
  </Connect>
</Response>`;
}

/** After the relay ends: transfer when asked, otherwise hang up. */
function relayEndedTwiml({ handoffData, callerNumber, transferNumber }) {
  let handoff = {};
  try { handoff = handoffData ? JSON.parse(handoffData) : {}; } catch (_) { /* not ours */ }
  if (handoff.reason === 'transfer' && transferNumber) {
    const callerId = callerNumber ? ` callerId="${esc(callerNumber)}"` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Transferring you to a team member now.</Say>
  <Dial${callerId}>${esc(transferNumber)}</Dial>
</Response>`;
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>';
}

class RelaySession {
  constructor(ws, { llm = null, transferNumber = null } = {}) {
    this.ws = ws;
    this.llm = llm;
    this.transferNumber = transferNumber;
    this.sm = createCallStateMachine();
    this.transcript = createTranscriptRecorder();
    this.callSid = null;
    this.sessionId = null;
    this.callerNumber = null;
    this.startedAt = Date.now();
    this.currentPromptText = GREETING.primary;
    this.callCompleted = false;
    this.transferRequested = false;
    this.cleanedUp = false;
    this.promptCounts = { state: null, counts: new Map() };
    this.turns = 0;
    this.goodbyeTimer = null;
    this.lastCallerAt = 0;
    this.transcript.add('ava', GREETING.primary); // Twilio plays the welcomeGreeting
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.cleanup().catch((e) => console.error('❌ Relay cleanup error:', e)));
    ws.on('error', (err) => console.error('❌ Relay socket error:', err.message));
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Say one line (one TTS cycle). */
  say(text, { last = true } = {}) {
    if (!text) return;
    const sinceCaller = this.lastCallerAt ? Date.now() - this.lastCallerAt : null;
    console.log(`🗣️ Relay says${sinceCaller != null ? ` (${sinceCaller} ms after the caller's text)` : ''}: "${text}"`);
    this.send({ type: 'text', token: text, last });
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    switch (msg.type) {
      case 'setup':
        this.callSid = msg.callSid;
        this.sessionId = msg.sessionId;
        this.callerNumber = msg.customParameters?.callerNumber || msg.from || null;
        if (this.callerNumber) this.sm.updateData('phone', this.callerNumber);
        console.log(`📞 Relay session ${this.sessionId} call ${this.callSid} from ${(this.callerNumber || '').replace(/(\d{3})\d{4}(\d{4})/, '$1***$2')} voice ${RELAY_VOICE}`);
        break;
      case 'prompt':
        if (!msg.last) return; // partial prompts are off; be safe
        this.lastCallerAt = Date.now();
        this.handleTurn(String(msg.voicePrompt || ''));
        break;
      case 'interrupt':
        console.log(`🛑 Caller interrupted after ${msg.durationUntilInterruptMs} ms: "${(msg.utteranceUntilInterrupt || '').slice(0, 60)}"`);
        break;
      case 'dtmf':
        console.log(`🔢 DTMF ${msg.digit}`);
        if (msg.digit === '0' && !this.transferRequested) this.transfer('dtmf');
        break;
      case 'tokens-played':
        if (this.callCompleted && !this.transferRequested) this.endCall('goodbye_played');
        break;
      case 'error':
        console.error(`❌ Relay error from Twilio: ${msg.description}`);
        break;
      default:
        break;
    }
  }

  handleTurn(text) {
    let transcript = text.trim();
    if (!transcript) return;
    console.log(`📝 User said: "${transcript}"`);
    this.sm.intakeLog('transcript', { transcript: transcript.substring(0, 100) });
    this.transcript.add('caller', transcript);
    if (this.callCompleted) return;
    this.turns++;

    const sm = this.sm;
    const state = sm.getState();
    const normalized = normalizeSpokenNumbers(transcript, { cardinals: state === STATES.PHONE || state === STATES.ADDRESS });
    if (normalized !== transcript) { console.log(`🔢 Numbers normalised: "${normalized}"`); transcript = normalized; }
    const lower = transcript.toLowerCase();

    if (BACKCHANNEL.test(transcript) && !/\b(is that (right|correct)|is everything correct)\?\s*$/i.test(this.currentPromptText || '')) {
      console.log(`🤫 Backchannel ignored: "${transcript}"`);
      return;
    }
    if (detectRealPersonRequest(transcript, state)) {
      console.log('🚨 Real person requested');
      return this.transfer('asked');
    }
    const explicitRepeat = /\b(repeat|say that again|say again|come again|didn'?t hear|can'?t hear|anybody there|anyone there)\b/i.test(lower);
    const bareHello = /^\W*(hello|hey|hi|hiya)(\W+(hello|hey|hi|there|ava|anybody|anyone))*\W*$/i.test(lower);
    if (((transcript.length < 35 && bareHello) || explicitRepeat) && ![STATES.CONFIRMATION, STATES.CLOSE, STATES.ENDED].includes(state)) {
      return this.speakPrompt(this.currentPromptText || sm.getNextPrompt());
    }

    const data = sm.getData();
    const analysis = {};
    if ((state === STATES.GREETING || state === STATES.INTENT) && !data.intent) {
      const r = classifyIntent(lower);
      if (r && typeof r === 'object') { analysis.intent = r.intent; analysis.isNewInstallation = r.isNew; }
      else if (r) analysis.intent = r;
      if (analysis.intent) console.log(`📋 Detected intent: ${analysis.intent}`);
    }

    const result = sm.processInput(transcript, analysis);
    console.log(`📍 State machine result: nextState=${result.nextState}, action=${result.action}`);

    if (result.action === 'end' || result.action === 'end_call') {
      const goodbye = result.prompt || CLOSE.goodbye;
      sm.updateData('_closeStateReached', true);
      this.callCompleted = true;
      sm.intakeLog('prompt', { prompt: goodbye.substring(0, 120) });
      this.transcript.add('ava', goodbye);
      this.say(goodbye);
      // Twilio reports tokens-played when the goodbye has been heard; end then, or at the fail-safe.
      this.goodbyeTimer = setTimeout(() => this.endCall('goodbye_failsafe'), goodbye === SAFETY.emergency_response ? 4000 : GOODBYE_FAILSAFE_MS);
      return;
    }
    if (result.action === 'wait') return;
    if (result.prompt) return this.speakPrompt(result.prompt);
    if (result.action === 'redirect_out_of_scope') return this.speakPrompt(OUT_OF_SCOPE.general);
    if (result.action === 'transfer_after_prompt') return this.transfer('script');
    if (result.action === 'classify_intent') return this.naturalReply(transcript, 'classify_intent');
    if (result.action === 'answer_question' || result.action === 'handle_correction') {
      if (sm.getState() === STATES.CLOSE) { sm.updateData('_anythingElsePrompted', false); return this.naturalReply(transcript, result.action); }
      const fallback = sm.getNextPrompt();
      return fallback ? this.speakPrompt(fallback) : this.naturalReply(transcript, result.action);
    }
    const fallback = sm.getNextPrompt();
    if (fallback) this.speakPrompt(fallback);
  }

  speakPrompt(prompt) {
    if (!prompt) return;
    const st = this.sm.getState();
    if (this.promptCounts.state !== st) this.promptCounts = { state: st, counts: new Map() };
    const seen = (this.promptCounts.counts.get(prompt) || 0) + 1;
    this.promptCounts.counts.set(prompt, seen);
    if (seen > SAME_PROMPT_LIMIT && prompt !== TRANSFER_OFFER_PROMPT) {
      console.warn(`🔁 Loop detected: "${prompt.slice(0, 50)}" asked ${seen} times in ${st}`);
      this.sm.intakeLog('state_event', { event: 'loop_break', state: st, prompt: prompt.substring(0, 80) });
      if (st === STATES.CONFIRMATION) { this.sm.transitionTo(STATES.CLOSE); return this.speakPrompt(CLOSE.anything_else); }
      return this.transfer('loop');
    }
    this.currentPromptText = prompt;
    this.sm.intakeLog('prompt', { prompt: prompt.substring(0, 120) });
    this.transcript.add('ava', prompt);
    this.say(prompt);
  }

  async naturalReply(userInput, action) {
    const sm = this.sm;
    if (!this.llm) return this.speakPrompt(sm.getNextPrompt() || 'I can take your information and have someone follow up. How can I help?');
    const data = sm.getData();
    const forbidden = 'FORBIDDEN - NEVER SAY: "next week" or "this week"; "lock in a time" or "get you scheduled"; any day confirmation; "we\'ll confirm everything"; "let me pull up available times"; any scheduling language; technician, tech, appointment. You do NOT schedule. You only collect information. Never quote prices. Plain spoken text only: no lists, no markdown, no emojis.';
    let instruction;
    if (action === 'classify_intent') {
      instruction = `Caller said: "${userInput}"\n\nFigure out what they need. Allowed services only: HVAC (heating, AC, service, maintenance, installation, upgrades), generators, the Energy Efficiency Program, memberships (Home Comfort Plans), existing projects. If they mention something else (solar, electrical, plumbing), say: "We specialize in HVAC, generators, and the Energy Efficiency Program. I can help with that if you need."\n\nRespond with one brief acknowledgement and ONE clarifying question about their need. Two sentences max.\n${forbidden}`;
    } else if (action === 'answer_question') {
      instruction = `Caller asked: "${userInput}"\n\nAnswer briefly. You are intake only: do not schedule or promise times. If you don't know specifics, say "I can take your info and have someone follow up." Then ask: "${CLOSE.anything_else}" Two sentences plus that question, max.\n${forbidden}`;
    } else {
      instruction = `Caller is correcting something: "${userInput}"\n\nCurrent info: name ${data.firstName || ''} ${data.lastName || ''}; phone ${data.phone || 'not yet'}; email ${data.email || 'not yet'}; address ${data.address || 'not yet'}.\nAsk what needs fixing, confirm briefly, move on. Keep it short.\n${forbidden}`;
    }
    const history = this.transcript.turns().slice(-8).map((t) => ({ role: t.speaker === 'ava' ? 'assistant' : 'user', content: t.text }));
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') history.push({ role: 'user', content: userInput });
    history.push({ role: 'user', content: instruction });
    const t0 = Date.now();
    try {
      // Sentences stream to Twilio as they come; the last one closes the TTS cycle.
      const pending = [];
      const full = await this.llm.reply({
        system: SYSTEM_PROMPT, messages: history, maxTokens: 160,
        onSentence: (s) => { if (pending.length === 0) console.log(`💬 LLM first sentence ${Date.now() - t0} ms`); pending.push(s); if (pending.length > 1) this.send({ type: 'text', token: `${pending.shift()} `, last: false }); },
      });
      const tail = pending.length ? pending.join(' ') : full;
      this.send({ type: 'text', token: tail, last: true });
      this.currentPromptText = full;
      this.transcript.add('ava', full);
      console.log(`📜 AI said: "${full}"`);
    } catch (err) {
      console.error(`❌ Reply generation failed: ${err.message}`);
      this.speakPrompt(sm.getNextPrompt() || CLOSE.anything_else);
    }
  }

  transfer(why) {
    if (this.transferRequested) return;
    this.transferRequested = true;
    this.callCompleted = true;
    this.sm.intakeLog('state_event', { event: 'transfer', reason: why });
    console.log(`📞 Transfer requested (${why}) -> ending relay with hand-off`);
    this.send({ type: 'end', handoffData: JSON.stringify({ reason: 'transfer', callerNumber: this.callerNumber }) });
  }

  endCall(why) {
    if (this.goodbyeTimer) { clearTimeout(this.goodbyeTimer); this.goodbyeTimer = null; }
    console.log(`📞 Ending relay (${why})`);
    this.sm.intakeLog('state_event', { event: 'hangup_executed', reason: why });
    this.send({ type: 'end' });
  }

  async cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.goodbyeTimer) clearTimeout(this.goodbyeTimer);
    let data = this.sm.getData();
    const currentState = this.sm.getState();
    data = await cleanCallData(data);
    console.log(`📋 Relay call done: state ${currentState}, ${this.turns} caller turns, ${Math.round((Date.now() - this.startedAt) / 1000)} s`);
    const callId = this.callSid || `RELAY-${Date.now()}`;
    logCallIntake(data, currentState, { callId, callerNumber: this.callerNumber, wasTransferred: this.transferRequested })
      .catch((err) => console.error('❌ Failed to log to Google Sheets:', err.message));
    const endedAt = Date.now();
    await saveCallToDb(data, currentState, {
      callId, twilioCallSid: this.callSid, callerNumber: this.callerNumber, wasTransferred: this.transferRequested,
      startedAt: this.startedAt, endedAt,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || 'local',
      transcript: this.transcript.turns(),
    }).catch((err) => console.error('❌ Call DB save rejected unexpectedly:', err.message));
  }
}

module.exports = { relayTwiml, relayEndedTwiml, RelaySession, RELAY_VOICE };
