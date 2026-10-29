/**
 * Phone mode: the real PSTN path. This script becomes the "application"
 * behind an outbound Twilio call: calls.create() dials Ava's number from a
 * test number, and the TwiML <Connect><Stream>s the caller leg back to a
 * small WebSocket server here. Twilio then speaks the same media-stream
 * protocol to us that it speaks to Ava, with the roles reversed: inbound
 * media is what Ava says, outbound media is what the caller says.
 *
 * Needs: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, a public URL for this
 * machine in TEST_CALLER_PUBLIC_URL (an ngrok tunnel to TEST_CALLER_PORT),
 * a `from` number in TEST_CALLER_NUMBERS that is a Twilio number on the
 * account, and Ava's number in TWILIO_NUMBER (or TEST_CALLER_TO).
 *
 * NEVER run this from GitHub Actions: Twilio has locked the account twice
 * for API calls from Actions runners. The guard below refuses to.
 */

const { EventEmitter } = require('events');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { FRAME_BYTES } = require('./audio');

class TwilioPhoneLeg extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.accountSid
   * @param {string} opts.authToken
   * @param {string} opts.from        test caller number (Twilio number on the account)
   * @param {string} opts.to          Ava's number
   * @param {string} opts.publicUrl   https://... reachable by Twilio, forwards to opts.port
   * @param {number} [opts.port]      local port, default 3100
   * @param {string} [opts.scenario]  name, passed through as a <Parameter> for the log
   */
  constructor(opts) {
    super();
    if (process.env.GITHUB_ACTIONS) {
      throw new Error('phone mode is not allowed on GitHub Actions runners (Twilio account lock-outs)');
    }
    this.opts = opts;
    this.port = opts.port || 3100;
    this.server = null;
    this.wss = null;
    this.ws = null;
    this.callSid = null;
    this.streamSid = null;
    this.closed = false;
    this.needsSilenceFrames = false; // Twilio supplies comfort noise itself
    this.twilio = require('twilio')(opts.accountSid, opts.authToken);
  }

  async connect() {
    await this.listen();
    const wsUrl = this.opts.publicUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/caller-stream';
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="scenario" value="${escapeXml(this.opts.scenario || '')}" />
    </Stream>
  </Connect>
</Response>`;
    const call = await this.twilio.calls.create({ to: this.opts.to, from: this.opts.from, twiml });
    this.callSid = call.sid;
    this.emit('dialing', { callSid: call.sid });
    await this.waitForStart(90000);
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('test-caller phone leg');
      });
      this.wss = new WebSocketServer({ server: this.server, path: '/caller-stream' });
      this.wss.on('connection', (ws) => {
        if (this.ws) {
          ws.close(1013, 'one call at a time');
          return;
        }
        this.ws = ws;
        ws.on('message', (data) => this.onMessage(data));
        ws.on('close', (code, reason) => {
          this.closed = true;
          this.emit('close', { code, reason: String(reason || ''), by: 'ava' });
        });
        ws.on('error', (err) => this.emit('error', err));
      });
      this.server.once('error', reject);
      this.server.listen(this.port, () => resolve());
    });
  }

  waitForStart(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Twilio never connected the media stream (is the public URL right and the tunnel up?)')), timeoutMs);
      this.once('start', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    switch (msg.event) {
      case 'connected':
        break;
      case 'start':
        this.streamSid = msg.start.streamSid;
        this.emit('start', { streamSid: this.streamSid, callSid: msg.start.callSid || this.callSid });
        break;
      case 'media': {
        const frame = Buffer.from(msg.media.payload, 'base64');
        this.emit('audio', frame);
        this.emit('heard', frame); // Twilio already played it in real time
        break;
      }
      case 'mark':
        this.emit('mark', msg.mark && msg.mark.name);
        break;
      case 'dtmf':
        break;
      case 'stop':
        this.emit('stop');
        break;
      default:
        break;
    }
  }

  sendAudio(frame) {
    if (frame.length !== FRAME_BYTES) throw new Error(`frame must be ${FRAME_BYTES} bytes`);
    this.send({ event: 'media', streamSid: this.streamSid, media: { payload: frame.toString('base64') } });
  }

  sendMark(name) {
    this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
  }

  sendDtmf() {
    // Not available over a bidirectional stream; would need a separate TwiML leg.
  }

  async hangup() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.callSid) await this.twilio.calls(this.callSid).update({ status: 'completed' });
    } catch (e) {
      this.emit('error', new Error(`could not end call ${this.callSid}: ${e.message}`));
    }
    this.shutdown();
    this.emit('close', { code: 1000, reason: 'caller hung up', by: 'caller' });
  }

  shutdown() {
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000); } catch (_) { /* ignore */ }
    try { if (this.wss) this.wss.close(); } catch (_) { /* ignore */ }
    try { if (this.server) this.server.close(); } catch (_) { /* ignore */ }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

module.exports = { TwilioPhoneLeg };
