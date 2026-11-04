/**
 * The conversation loop of one test call, shared by the harness (run.js,
 * local and phone mode) and the daily full smoke call inside the production
 * server (src/monitor/smoke-full-call.js).
 *
 * `leg` is the line to Ava: it emits 'audio' (each frame Ava sends), 'heard'
 * (what the caller hears, after playout; null on a silent tick), 'clear',
 * 'close' ({ by, code, reason }), and has sendAudio(frame), hangup() and
 * needsSilenceFrames. `persona` is a Persona (persona.js).
 */

const { FRAME_MS, SILENCE_FRAME, isDigitalSilence, isAudible, toFrames, TrackRecorder } = require('./audio');
const report = require('./report');

async function runCall({ args, scenario, leg, persona, clips, outDir, log }) {
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const events = [];
  const turns = []; // transcript rows { t, speaker, text }
  const callerUtts = []; // { start, end, tag, text }
  const avaUtts = []; // { start, end, firstAudible, text }
  const recorder = new TrackRecorder();
  const queue = []; // outgoing { frame, tag }
  const activeResponses = new Set();
  const responseFirstSend = new Map(); // responseId -> ms
  const speechStartedAt = new Map(); // persona item_id -> ms (Ava speech detected)
  let clears = 0; // barge-in clears
  let routineClears = 0; // clear-before-speaking, Ava's normal behaviour
  let interjectionsFired = 0;
  let nudges = 0; // caller nudged to answer a question it sat on
  let nudgedUtterance = 0; // avaUtts.length at the last nudge
  const NUDGE_AFTER_MS = scenario.nudgeAfterMs || 5000;
  let callerSpeaking = false;
  let callerLastSendAt = 0;
  let avaSpeaking = false;
  let avaLastAudioAt = 0;
  let endInfo = null;
  let hangupTimer = null;

  const event = (type, extra = {}) => {
    const e = { t: now(), type, ...extra };
    events.push(e);
    return e;
  };
  const say = (line) => { if (!args.quiet) console.log(line); };
  const note = (text) => {
    turns.push({ t: now(), speaker: 'event', text });
    say(`  [${report.fmtTime(now())}] -- ${text}`);
  };

  // Ava -> caller --------------------------------------------------------
  leg.on('audio', (frame) => {
    const t = now();
    recorder.add('ava', t, frame);
    if (!isDigitalSilence(frame)) {
      if (!avaSpeaking) {
        avaSpeaking = true;
        avaUtts.push({ start: t, end: null, firstAudible: null, text: '' });
        event('ava_audio_start', { utterance: avaUtts.length });
      }
      avaLastAudioAt = t;
      const u = avaUtts[avaUtts.length - 1];
      if (u.firstAudible == null && isAudible(frame)) u.firstAudible = t;
    }
  });
  leg.on('heard', (frame) => { if (frame) persona.feedAudio(frame); });
  // Ava sends `clear` before every response she starts (routine). It is a
  // barge-in only when she was talking and the caller was talking too.
  leg.on('clear', ({ droppedFrames }) => {
    const bargeIn = avaSpeaking && callerSpeaking;
    if (bargeIn) clears++; else routineClears++;
    event('ava_clear', { droppedFrames, bargeIn });
    if (bargeIn) note(`Ava stopped talking because the caller spoke (barge-in), ${droppedFrames} frames dropped`);
  });
  leg.on('protocol-error', (m) => { event('protocol_error', { message: m }); say(`  !! ${m}`); });
  leg.on('error', (err) => { event('leg_error', { message: err.message }); say(`  !! leg error: ${err.message}`); });

  // Persona -> wire -------------------------------------------------------
  persona.on('response_started', (id) => activeResponses.add(id));
  persona.on('response_done', (id, status) => {
    activeResponses.delete(id);
    event('caller_response_done', { responseId: id, status });
  });
  // Once the caller has said goodbye they stop talking, like a person who is
  // lowering the phone; if Ava has not ended the call shortly after, they hang up.
  let goodbyeAt = null;
  let goodbyeResponseId = null;
  const hangupAfterGoodbyeMs = scenario.hangupAfterGoodbyeMs || 15000;
  persona.on('audio', (buf, responseId) => {
    if (endInfo) return;
    if (goodbyeAt != null && responseId !== goodbyeResponseId) return; // said goodbye already
    for (const frame of toFrames(buf)) queue.push({ frame, tag: responseId });
  });
  persona.on('caller_transcript', (text, responseId) => {
    if (goodbyeAt != null && responseId !== goodbyeResponseId) return; // audio was never sent
    const utt = callerUtts.find((u) => u.tag === responseId);
    const t = utt ? utt.start : (responseFirstSend.get(responseId) ?? now());
    if (utt) utt.text = text;
    turns.push({ t, speaker: 'caller', text });
    say(`  [${report.fmtTime(t)}] CALLER: ${text}`);
    if (goodbyeAt == null && /\b(bye|goodbye)\b/i.test(text)) {
      goodbyeAt = now();
      goodbyeResponseId = responseId;
      event('caller_goodbye', { responseId });
      setTimeout(() => {
        if (endInfo) return;
        note(`caller hung up ${Math.round(hangupAfterGoodbyeMs / 1000)} s after saying goodbye; Ava had not ended the call`);
        event('caller_hangup_after_goodbye');
        leg.hangup();
      }, hangupAfterGoodbyeMs);
    }
  });
  persona.on('ava_speech_started', (itemId) => { speechStartedAt.set(itemId, now()); event('persona_vad_start', { itemId }); });
  persona.on('ava_speech_stopped', (itemId) => event('persona_vad_stop', { itemId }));
  persona.on('ava_transcript', (text, itemId) => {
    const t = speechStartedAt.get(itemId) ?? now();
    turns.push({ t, speaker: 'ava', text });
    // Attach to the Ava utterance that was running at that moment (or the last one).
    const u = [...avaUtts].reverse().find((x) => x.start <= t + 400) || avaUtts[avaUtts.length - 1];
    if (u) u.text = u.text ? `${u.text} ${text}` : text;
    say(`  [${report.fmtTime(t)}] AVA:    ${text}`);
  });
  persona.on('error', (err) => { event('persona_error', { message: err.message }); say(`  !! persona: ${err.message}`); });

  // 20 ms pacer: one frame out per tick, utterance bookkeeping ------------
  const pending = scenario.interjections.map((i) => ({ ...i, fired: false }));
  const tick = setInterval(() => {
    if (endInfo) return;
    const t = now();

    // Interjections: the caller says something while Ava is mid-sentence.
    if (avaSpeaking) {
      const u = avaUtts[avaUtts.length - 1];
      for (const i of pending) {
        if (!i.fired && avaUtts.length === i.onAvaUtterance && t - u.start >= (i.afterMs || 1000)) {
          i.fired = true;
          interjectionsFired++;
          const clip = clips[i.text];
          if (clip) {
            const frames = toFrames(clip).map((frame) => ({ frame, tag: `clip:${i.text}` }));
            queue.unshift(...frames);
            event('interjection', { text: i.text, onAvaUtterance: i.onAvaUtterance });
            note(`caller interjects "${i.text}" while Ava is talking`);
          }
        }
      }
    }

    // Outgoing audio.
    if (queue.length) {
      const { frame, tag } = queue.shift();
      leg.sendAudio(frame);
      recorder.add('caller', t, frame);
      callerLastSendAt = t;
      if (!callerSpeaking) {
        callerSpeaking = true;
        callerUtts.push({ start: t, end: null, tag, text: tag.startsWith('clip:') ? `(${tag.slice(5)})` : '' });
        event('caller_speech_start', { tag });
      }
      if (!tag.startsWith('clip:') && !responseFirstSend.has(tag)) responseFirstSend.set(tag, t);
    } else {
      if (leg.needsSilenceFrames) leg.sendAudio(SILENCE_FRAME);
      if (callerSpeaking && t - callerLastSendAt > 400 && activeResponses.size === 0) {
        callerSpeaking = false;
        const u = callerUtts[callerUtts.length - 1];
        u.end = callerLastSendAt + FRAME_MS;
        event('caller_speech_end', { tag: u.tag });
      }
    }

    // Ava utterance end: 600 ms with nothing but silence frames.
    if (avaSpeaking && t - avaLastAudioAt > 600) {
      avaSpeaking = false;
      const u = avaUtts[avaUtts.length - 1];
      u.end = avaLastAudioAt + FRAME_MS;
      event('ava_audio_end', { utterance: avaUtts.length });
    }

    // Ava finished talking a while ago and the caller has done nothing since
    // (no response started, nothing queued): the persona's VAD missed the
    // turn. Nudge it once per Ava utterance, like a person who realises
    // they were asked something.
    if (!avaSpeaking && !callerSpeaking && avaUtts.length && goodbyeAt == null
      && activeResponses.size === 0 && queue.length === 0
      && nudgedUtterance !== avaUtts.length) {
      const last = avaUtts[avaUtts.length - 1];
      const lastCallerEnd = callerUtts.length ? (callerUtts[callerUtts.length - 1].end || 0) : 0;
      if (last.end != null && last.end > lastCallerEnd && t - last.end >= NUDGE_AFTER_MS) {
        nudgedUtterance = avaUtts.length;
        nudges++;
        event('caller_nudged', { utterance: avaUtts.length, silentMs: t - last.end });
        note(`caller nudged to answer: nothing said ${Math.round((t - last.end) / 1000)} s after Ava's question`);
        persona.nudge();
      }
    }
  }, FRAME_MS);

  // Call end ----------------------------------------------------------------
  const ended = new Promise((resolve) => {
    leg.on('close', (info) => {
      if (endInfo) return;
      endInfo = { ...info, t: now() };
      event('call_end', endInfo);
      resolve();
    });
  });
  const maxMs = (scenario.maxCallSeconds || 240) * 1000;
  hangupTimer = setTimeout(() => {
    if (endInfo) return;
    note(`max call length ${scenario.maxCallSeconds || 240}s reached, caller hangs up`);
    event('timeout');
    leg.hangup();
  }, maxMs);

  await ended;
  clearTimeout(hangupTimer);
  if (callerSpeaking) callerUtts[callerUtts.length - 1].end = callerLastSendAt + FRAME_MS;
  if (avaSpeaking) avaUtts[avaUtts.length - 1].end = avaLastAudioAt + FRAME_MS;
  say(`  call ended by ${endInfo.by} after ${report.fmtTime(endInfo.t)} (code ${endInfo.code}${endInfo.reason ? ', ' + endInfo.reason : ''})`);

  // Late transcripts still arrive for a moment.
  await report.sleep(2500);
  clearInterval(tick);
  persona.close();

  const endedHow = endInfo.by === 'ava'
    ? 'Ava ended the call'
    : events.some((e) => e.type === 'caller_hangup_after_goodbye')
      ? `caller hung up ${Math.round(hangupAfterGoodbyeMs / 1000)} s after saying goodbye (Ava never hung up)`
      : events.some((e) => e.type === 'timeout')
        ? `caller gave up at the ${scenario.maxCallSeconds || 240} s limit (Ava never hung up)`
        : 'caller hung up';
  return { t0, events, turns, callerUtts, avaUtts, recorder, clears, routineClears, interjectionsFired, nudges, endInfo, endedHow };
}

module.exports = { runCall };
