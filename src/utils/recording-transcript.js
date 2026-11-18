/**
 * The transcript of a call, taken from its recording.
 *
 * The transcript the server keeps during a call is what Ava was TOLD to say
 * and what the transcriber REPORTED the caller said. On a real call (Tim,
 * Nov 18 2026) that was wrong three ways: a line that was cut off after five
 * words was shown in full, a line that was never spoken was shown as spoken,
 * and Ava's own voice echoing on the caller's line was shown as the caller
 * saying "Nine four zero four".
 *
 * So once the recording is stored, both tracks are transcribed and that
 * becomes the call's transcript: what was actually on the line. Three things
 * are marked in it:
 *   - an echo: words on the caller's track that are Ava's own, said at the same moment;
 *   - a line of Ava's that was cut off (the full line is given);
 *   - a line of Ava's that is not on the recording at all.
 * The server's own transcript is kept in calls.intake_json.server_transcript.
 *
 * Off with RECORDING_TRANSCRIPT=off. Needs DEEPGRAM_API_KEY. Never throws.
 */

const { shapeForSpeech } = require('../pipeline/speech-shaping');

const ENABLED = (process.env.RECORDING_TRANSCRIPT || 'on').toLowerCase() !== 'off';
const DEEPGRAM_QUERY = process.env.RECORDING_TRANSCRIPT_QUERY || 'model=nova-3&language=en&multichannel=true&utterances=true&punctuate=true&smart_format=true';

/** Two 8 kHz PCM16 tracks as one stereo WAV: caller on channel 0, Ava on channel 1. */
function stereoWav(caller, ava) {
  const frames = Math.max(caller.length, ava.length);
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(8000 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(i < caller.length ? caller[i] : 0, 44 + i * 4);
    buf.writeInt16LE(i < ava.length ? ava[i] : 0, 46 + i * 4);
  }
  return buf;
}

/** Send a stereo WAV to Deepgram; returns [{ speaker, start, end, text, words: [{ w, start, end }], confidence }] in time order. */
async function transcribeWav(wav, { apiKey = process.env.DEEPGRAM_API_KEY, fetchImpl = fetch, avaChannel = 1 } = {}) {
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');
  const res = await fetchImpl(`https://api.deepgram.com/v1/listen?${DEEPGRAM_QUERY}`, { method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' }, body: wav });
  if (!res.ok) throw new Error(`Deepgram ${res.status}`);
  const j = await res.json();
  return ((j.results && j.results.utterances) || [])
    .filter((u) => u.transcript && u.transcript.trim())
    .map((u) => ({
      speaker: u.channel === avaChannel ? 'ava' : 'caller',
      start: u.start,
      end: u.end,
      text: u.transcript.trim(),
      words: (u.words || []).map((w) => ({ w: w.word, start: w.start, end: w.end })),
      confidence: (u.words || []).length ? u.words.reduce((a, w) => a + w.confidence, 0) / u.words.length : 1,
    }))
    .sort((a, b) => a.start - b.start);
}

const NUMBER_WORDS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
/** Words for comparing: lower case, "okay" for "ok", digits one at a time ("07940" and "zero seven nine four zero" match). */
function tokens(text) {
  const out = [];
  for (const raw of String(text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean)) {
    const w = raw === 'ok' ? 'okay' : raw;
    if (NUMBER_WORDS[w]) out.push(NUMBER_WORDS[w]);
    else if (/^\d+$/.test(w)) out.push(...w.split(''));
    else out.push(w);
  }
  return out;
}
/** How many of `need`, in order, are found in `hay`. */
function inOrder(need, hay) {
  let at = 0;
  let hit = 0;
  for (const w of need) {
    const found = hay.indexOf(w, at);
    if (found >= 0) { hit++; at = found + 1; }
  }
  return hit;
}

/**
 * Turn the two tracks' utterances into the call's transcript.
 * `serverTurns` is the transcript the server kept during the call ([{ speaker, text, at }]).
 * Returns [{ sequence, speaker, text, at }], `at` as a Date.
 */
function buildHeardTurns(utterances, serverTurns = [], { recordingStartedAt } = {}) {
  const us = utterances.map((u) => ({ ...u }));
  const avaWords = us.filter((u) => u.speaker === 'ava').flatMap((u) => u.words);

  // 1. Echo: words on the caller's track that Ava is saying at that moment.
  for (const u of us) {
    if (u.speaker !== 'caller') continue;
    const mine = tokens(u.text);
    if (!mine.length) continue;
    const hers = tokens(avaWords.filter((w) => w.end >= u.start - 2 && w.start <= u.end + 0.3).map((w) => w.w).join(' '));
    if (!hers.length) continue;
    const share = inOrder(mine, hers) / mine.length;
    u.echo = mine.length <= 2 ? share === 1 : share >= 0.6;
  }

  // 2. One turn per stretch of speech by the same voice.
  const turns = [];
  for (const u of us) {
    const kind = u.speaker === 'caller' && u.echo ? 'echo' : u.speaker;
    const last = turns[turns.length - 1];
    if (last && last.kind === kind && u.start - last.end < 1.5) { last.text = `${last.text} ${u.text}`; last.end = u.end; last.confidence = Math.min(last.confidence, u.confidence); } else turns.push({ kind, speaker: u.speaker, start: u.start, end: u.end, text: u.text, confidence: u.confidence });
  }

  // 3. Ava's lines as the server sent them: cut off, or not on the recording at all?
  const sent = serverTurns.filter((t) => t.speaker === 'ava' && t.text).map((t) => ({ text: t.text, at: new Date(t.at).getTime() }));
  const t0 = recordingStartedAt ? new Date(recordingStartedAt).getTime() : (sent[0] ? sent[0].at : Date.now());
  const extra = [];
  sent.forEach((s) => { s.sec = (s.at - t0) / 1000; s.need = tokens(shapeForSpeech(s.text)); s.heard = []; });
  // Each stretch of Ava's speech belongs to the sent line it sounds most like (sent a little before it was heard).
  for (const h of turns) {
    if (h.kind !== 'ava') continue;
    const mine = tokens(h.text);
    let best = null;
    for (const s of sent) {
      if (s.sec > h.start + 3 || s.sec < h.start - 20) continue;
      const score = inOrder(mine, s.need) / Math.max(1, mine.length);
      if (score >= 0.5 && (!best || score > best.score)) best = { s, score };
    }
    if (best) best.s.heard.push(h);
  }
  for (const s of sent) {
    if (s.need.length < 3) continue;
    if (!s.heard.length) {
      // Said in the same breath as another line? Then it is on the recording after all.
      const near = tokens(turns.filter((t) => t.kind === 'ava' && t.end > s.sec - 2 && t.start < s.sec + 15).map((t) => t.text).join(' '));
      if (inOrder(s.need, near) / s.need.length >= 0.6) continue;
      extra.push({ kind: 'note', speaker: 'ava', start: Math.max(0, s.sec), end: s.sec, text: `[Not on the recording. This line of Ava's was sent but never spoken: "${s.text}"]`, confidence: 1 });
      continue;
    }
    const got = inOrder(s.need, tokens(s.heard.map((t) => t.text).join(' '))) / s.need.length;
    const lastHeard = s.heard[s.heard.length - 1];
    if (got < 0.6 && s.need.length >= 5 && !/\[cut off/.test(lastHeard.text)) lastHeard.text = `${lastHeard.text} [cut off here. The full line was: "${s.text}"]`;
  }

  const all = turns.concat(extra).sort((a, b) => a.start - b.start);
  return all.map((t, i) => ({
    sequence: i + 1,
    speaker: t.speaker,
    text: t.kind === 'echo' ? `[Not the caller: Ava's own voice echoing on the caller's line: "${t.text}"]`
      : t.kind === 'ava' && t.confidence < 0.8 && !/\[cut off/.test(t.text) ? `${t.text} [hard to make out on the recording]` : t.text,
    at: new Date(t0 + Math.round(t.start * 1000)),
  }));
}

/**
 * Transcribe a stored call's two tracks and make that the call's transcript. Never throws.
 * `tracks` are 8 kHz PCM16 Int16Arrays; `db` is src/utils/call-db.js (passed in to avoid a require cycle).
 */
async function transcribeAndStore(callRowId, tracks, db, opts = {}) {
  if (!ENABLED) return { ok: false, skipped: true, reason: 'RECORDING_TRANSCRIPT=off' };
  if (!process.env.DEEPGRAM_API_KEY && !opts.apiKey) return { ok: false, skipped: true, reason: 'no DEEPGRAM_API_KEY' };
  try {
    const utterances = await transcribeWav(stereoWav(tracks.caller, tracks.ava), opts);
    if (!utterances.length) return { ok: false, reason: 'nothing heard on the recording' };
    const serverTurns = await db.getTranscriptTurns(callRowId);
    if (serverTurns === null) return { ok: false, reason: 'could not read the call' };
    const turns = buildHeardTurns(utterances, serverTurns);
    const saved = await db.replaceTranscriptFromRecording(callRowId, turns, serverTurns);
    return { ok: Boolean(saved && saved.success), turns: turns.length, echoes: turns.filter((t) => t.text.startsWith('[Not the caller')).length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { stereoWav, transcribeWav, buildHeardTurns, transcribeAndStore, tokens };
