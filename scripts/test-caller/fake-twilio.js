/**
 * Fake Twilio: a WebSocket client that connects to Ava's /stream and speaks
 * the Twilio media-stream protocol exactly, so Ava cannot tell it from a
 * real call. Local mode only; no Twilio account involved.
 *
 * Protocol (https://www.twilio.com/docs/voice/media-streams/websocket-messages):
 *   -> connected        once, right after the socket opens
 *   -> start            streamSid / callSid / mediaFormat / customParameters
 *   -> media            20 ms frames, base64 mu-law 8 kHz, inbound track
 *   -> dtmf             a keypad digit
 *   -> mark             echoed back after the named playback point is reached
 *   -> stop             the call ended
 *   <- media            Ava's audio, outbound track
 *   <- mark             Ava asks to be told when playback reaches this point
 *   <- clear            Ava wants everything still buffered to be dropped
 *
 * Inbound audio goes through a playout buffer that is drained at real time,
 * one frame per 20 ms tick, just as the carrier side would: a `clear` drops
 * whatever has not played yet, and marks are echoed when playback reaches
 * them. What comes out of that buffer is "what the caller heard".
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { FRAME_MS, FRAME_BYTES } = require('./audio');

function fakeSid(prefix) {
  return prefix + crypto.randomBytes(16).toString('hex');
}

class FakeTwilioClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url            ws://host:port/stream
   * @param {string} opts.callerNumber   value of the callerNumber <Parameter>
   * @param {string} [opts.streamSid]
   * @param {string} [opts.callSid]
   */
  constructor({ url, callerNumber, streamSid, callSid }) {
    super();
    this.url = url;
    this.callerNumber = callerNumber;
    this.streamSid = streamSid || fakeSid('MZ');
    this.callSid = callSid || fakeSid('CA');
    this.accountSid = 'AC' + '0'.repeat(32);
    this.ws = null;
    this.seq = 0;
    this.chunk = 0;
    this.timestampMs = 0;
    this.playout = []; // [{ frame, atMs }] frames from Ava not yet "heard"
    this.pendingMarks = []; // [{ name, afterFrames }] marks waiting on playout
    this.playTimer = null;
    this.closed = false;
    this.needsSilenceFrames = true; // a real phone leg streams silence too
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.once('open', () => {
        this.sendEvent({ event: 'connected', protocol: 'Call', version: '1.0.0' });
        this.sendEvent({
          event: 'start',
          start: {
            accountSid: this.accountSid,
            streamSid: this.streamSid,
            callSid: this.callSid,
            tracks: ['inbound'],
            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
            customParameters: { callerNumber: this.callerNumber },
          },
          streamSid: this.streamSid,
        });
        this.startPlayout();
        this.emit('start', { streamSid: this.streamSid, callSid: this.callSid });
        resolve();
      });
      this.ws.once('error', (err) => {
        if (!this.closed) this.emit('error', err);
        reject(err);
      });
      this.ws.on('message', (data) => this.onMessage(data));
      this.ws.on('close', (code, reason) => {
        this.stopPlayout();
        this.closed = true;
        this.emit('close', { code, reason: String(reason || ''), by: 'ava' });
      });
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      this.emit('protocol-error', `non-JSON message from Ava: ${String(data).slice(0, 80)}`);
      return;
    }
    switch (msg.event) {
      case 'media': {
        const frame = Buffer.from(msg.media.payload, 'base64');
        this.emit('audio', frame); // as received, before playout
        this.playout.push(frame);
        break;
      }
      case 'clear': {
        const dropped = this.playout.length;
        this.playout = [];
        this.pendingMarks = [];
        this.emit('clear', { droppedFrames: dropped });
        break;
      }
      case 'mark': {
        // Echo once playback reaches it: that is after everything queued now.
        this.pendingMarks.push({ name: msg.mark && msg.mark.name, afterFrames: this.playout.length });
        break;
      }
      default:
        this.emit('protocol-error', `unexpected event from Ava: ${msg.event}`);
    }
  }

  startPlayout() {
    this.playTimer = setInterval(() => {
      if (this.playout.length) {
        const frame = this.playout.shift();
        this.emit('heard', frame);
        for (const m of this.pendingMarks) m.afterFrames--;
      } else {
        this.emit('heard', null); // the caller heard nothing this tick
      }
      while (this.pendingMarks.length && this.pendingMarks[0].afterFrames <= 0) {
        const m = this.pendingMarks.shift();
        this.sendEvent({ event: 'mark', streamSid: this.streamSid, mark: { name: m.name } });
      }
    }, FRAME_MS);
  }

  stopPlayout() {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
  }

  /** Send one 20 ms mu-law frame as the caller's inbound audio. */
  sendAudio(frame) {
    if (frame.length !== FRAME_BYTES) throw new Error(`frame must be ${FRAME_BYTES} bytes`);
    this.chunk++;
    this.sendEvent({
      event: 'media',
      media: {
        track: 'inbound',
        chunk: String(this.chunk),
        timestamp: String(this.timestampMs),
        payload: frame.toString('base64'),
      },
      streamSid: this.streamSid,
    });
    this.timestampMs += FRAME_MS;
  }

  sendDtmf(digit) {
    this.sendEvent({ event: 'dtmf', streamSid: this.streamSid, dtmf: { track: 'inbound_track', digit: String(digit) } });
  }

  /** The caller hung up: Twilio sends stop, then closes. */
  hangup() {
    if (this.closed) return;
    this.closed = true;
    this.stopPlayout();
    try {
      this.sendEvent({
        event: 'stop',
        stop: { accountSid: this.accountSid, callSid: this.callSid },
        streamSid: this.streamSid,
      });
      this.ws.close(1000, 'caller hung up');
    } catch (_) { /* already gone */ }
    this.emit('close', { code: 1000, reason: 'caller hung up', by: 'caller' });
  }

  sendEvent(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (obj.event !== 'connected') obj.sequenceNumber = String(++this.seq);
    this.ws.send(JSON.stringify(obj));
  }
}

module.exports = { FakeTwilioClient, fakeSid };
