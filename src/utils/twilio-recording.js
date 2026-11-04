/**
 * Recordings for calls whose audio never passes through this server
 * (Twilio ConversationRelay, src/relay.js): Twilio records the call on
 * request, tells us when the file is ready (recordingStatusCallback), and we
 * pull the dual-channel WAV, split it into the two 8 kHz mu-law tracks the
 * `recordings` table holds, and store it against the call row, so the web app
 * plays it exactly like a media-stream recording.
 *
 * Twilio's WAV: RIFF, 16-bit PCM, 8 kHz, two channels when fetched with
 * RequestedChannels=2. Which channel is the caller is decided by listening:
 * Ava speaks first (the greeting), so the channel with more energy in the
 * first seconds is hers.
 */

const { pcm16ToMuLaw, muLawToPcm16 } = require('../g711');
const { findCallRowIdBySid, saveRecordingTracks } = require('./call-db');

/** Ask Twilio to record a live call, both legs on their own channel. */
async function startCallRecording({ twilioClient, callSid, statusCallbackUrl }) {
  if (!twilioClient || !callSid) return null;
  const rec = await twilioClient.calls(callSid).recordings.create({
    recordingChannels: 'dual',
    recordingStatusCallback: statusCallbackUrl,
    recordingStatusCallbackEvent: ['completed'],
    recordingStatusCallbackMethod: 'POST',
  });
  return rec && rec.sid;
}

/** Parse a RIFF/WAVE buffer with 16-bit PCM; returns { sampleRate, channels: Int16Array[] }. */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { data = buf.subarray(body, Math.min(buf.length, body + size)); break; }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV without fmt or data chunk');
  const nCh = fmt.channels;
  let samples;
  if (fmt.format === 1 && fmt.bits === 16) {
    samples = new Int16Array(data.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  } else if (fmt.format === 7 && fmt.bits === 8) { // mu-law
    samples = muLawToPcm16(data);
  } else {
    throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
  }
  const frames = Math.floor(samples.length / nCh);
  const channels = [];
  for (let c = 0; c < nCh; c++) {
    const ch = new Int16Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = samples[i * nCh + c];
    channels.push(ch);
  }
  return { sampleRate: fmt.sampleRate, channels };
}

function energy(ch, from, to) {
  let s = 0;
  const end = Math.min(to, ch.length);
  for (let i = from; i < end; i++) s += ch[i] * ch[i];
  return s;
}

/** Simple decimation to 8 kHz when Twilio returns a higher rate (it normally returns 8 kHz). */
function to8k(ch, sampleRate) {
  if (sampleRate === 8000) return ch;
  const step = sampleRate / 8000;
  const out = new Int16Array(Math.floor(ch.length / step));
  for (let i = 0; i < out.length; i++) out[i] = ch[Math.floor(i * step)];
  return out;
}

/**
 * Download Twilio's recording and store it against the call. Returns what
 * happened; never throws (the caller logs).
 */
async function ingestTwilioRecording({ recordingUrl, callSid, accountSid, authToken, source = 'twilio', fetchImpl = fetch, retries = 6 }) {
  if (!recordingUrl || !callSid) return { ok: false, reason: 'missing recordingUrl or callSid' };
  let callRowId = null;
  for (let i = 0; i < retries && !callRowId; i++) {
    callRowId = await findCallRowIdBySid(callSid);
    if (!callRowId) await new Promise((r) => setTimeout(r, 2000)); // the call row is written at hang-up; Twilio can be quicker
  }
  if (!callRowId) return { ok: false, reason: `no call row for ${callSid}` };
  const url = `${recordingUrl}.wav?RequestedChannels=2`;
  const res = await fetchImpl(url, { headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` } });
  if (!res.ok) return { ok: false, reason: `download ${res.status}` };
  const wav = Buffer.from(await res.arrayBuffer());
  const { sampleRate, channels } = parseWav(wav);
  const tracks = channels.map((c) => to8k(c, sampleRate));
  let caller = tracks[0];
  let ava = tracks[1] || tracks[0];
  if (tracks.length >= 2) {
    // Ava greets first: the channel with more energy in the first 6 s is hers.
    const first = 8000 * 6;
    if (energy(tracks[0], 0, first) > energy(tracks[1], 0, first)) { ava = tracks[0]; caller = tracks[1]; }
  }
  const saved = await saveRecordingTracks(callRowId, { caller: pcm16ToMuLaw(caller), ava: pcm16ToMuLaw(ava) }, source);
  return { ok: Boolean(saved && saved.success), callRowId, seconds: Math.round(caller.length / 8000), saved };
}

module.exports = { startCallRecording, ingestTwilioRecording, parseWav };
