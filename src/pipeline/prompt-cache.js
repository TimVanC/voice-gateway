/**
 * Pre-synthesised audio for the script's fixed lines (Sierra's trick: the
 * greeting and every fixed question are rendered once at start-up, so when
 * the state machine asks for one it plays with zero synthesis delay).
 *
 * Dynamic prompts (read-backs, the recap) are synthesised live; the ones that
 * repeat within a process ("I have 973 555 0142. Is that correct?") are kept
 * in a small LRU so a re-ask is instant too.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const script = require('../scripts/rse-script');

// Rendered prompts are kept on disk (gitignored) keyed by provider, model,
// voice and text, so a restart costs no TTS characters: the ElevenLabs free
// tier has a small monthly character budget and every warm-up would eat it.
const CACHE_DIR = process.env.PROMPT_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'prompt-cache');

// The state machine prefixes many prompts with one of these (call-state-machine.js
// getAcknowledgment). They are cached on their own so "Okay. What's the best
// phone number to reach you?" can be played as two cached pieces.
const ACKNOWLEDGEMENTS = [
  'Got it.', 'Okay.', 'Thanks.', 'Thank you.',
  "I'm sorry to hear that.", "I'm sorry you're dealing with that.", 'Thanks for letting me know.',
];
// Pause between the acknowledgement and the question. 120 ms ran "Okay." and
// "What's the best phone number..." together (Tim, Nov 3 2026: "goes right
// into the next question way too fast"); a person takes about half a second.
const ACK_GAP_MS = Number(process.env.ACK_GAP_MS || 500);
const ACK_GAP = Buffer.alloc(8 * ACK_GAP_MS, 0xff);

// A render that runs well past what its text warrants is a stretched one
// (ElevenLabs held "tiiiime" on the availability question, staging, Nov 3
// 2026: fresh takes of that line came out 2.1 s, 2.3 s and 5.4 s) and would
// replay on every call from the cache: it is rendered again and the shorter
// take kept. Measured on 57 Eryn renders at speed 0.92: about 0.35 s plus
// 0.07 s per character, within 15 %.
const RENDER_RETRIES = 2;
function expectedSeconds(text) { return 0.35 + 0.07 * String(text || '').length; }
function looksStretched(text, buf) {
  if (!buf || !buf.length || !text) return false;
  return buf.length / 8000 > expectedSeconds(text) * 1.25 + 0.3;
}

/** Every fixed line Ava can say, deduplicated, in the order the script lists them. */
function collectFixedPrompts(extra = []) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string') { if (v.trim() && !out.includes(v)) out.push(v); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) add(x);
  };
  add(script.GREETING);
  add(script.INTENT_PROMPTS);
  add(script.SAFETY);
  add(script.CALLER_INFO);
  add(script.DETAILS);
  add(script.ADDRESS);
  add(script.AVAILABILITY);
  add(script.CONFIRMATION);
  add(script.CLOSE);
  add(script.OUT_OF_SCOPE);
  add(script.NEUTRAL);
  // Combinations the state machine builds from fixed parts.
  add(`${script.SAFETY.all_clear} ${script.CALLER_INFO.name}`);
  add(`Sorry, I didn't catch that. ${script.CALLER_INFO.name}`);
  for (const e of extra) add(e);
  for (const a of ACKNOWLEDGEMENTS) add(a);
  // Prefix fragments ("Did I get your last name right.", "I have") only make
  // sense with the caller's value appended, so they are synthesised live.
  return out.filter((p) => !/^(Did I get|Did you say|I have)\b/.test(p) && (p.length > 8 || ACKNOWLEDGEMENTS.includes(p)));
}

class PromptCache {
  constructor({ tts, maxDynamic = 200, diskKey = null } = {}) {
    this.tts = tts;
    this.diskKey = diskKey; // e.g. "elevenlabs:eleven_flash_v2_5:EXAV..." ; null disables the disk cache
    this.fromDisk = 0;
    this.fixed = new Map();   // text -> Buffer (mu-law)
    this.dynamic = new Map(); // text -> Buffer, LRU
    this.maxDynamic = maxDynamic;
    this.ready = false;
    this.failed = 0;
    this.seconds = 0;
    this.hits = 0;
    this.misses = 0;
    this.composed = 0; // hits served as acknowledgement + prompt
  }

  _lookup(key) {
    let buf = this.fixed.get(key);
    if (!buf && this.dynamic.has(key)) {
      buf = this.dynamic.get(key);
      this.dynamic.delete(key);
      this.dynamic.set(key, buf); // refresh LRU order
    }
    return buf || null;
  }

  get(text) {
    const key = String(text || '').trim();
    let buf = this._lookup(key);
    if (!buf) {
      // "Okay. What's the best phone number to reach you?" = cached ack + cached prompt.
      for (const ack of ACKNOWLEDGEMENTS) {
        if (!key.startsWith(`${ack} `)) continue;
        const a = this._lookup(ack);
        const rest = this._lookup(key.slice(ack.length + 1).trim());
        if (a && rest) { buf = Buffer.concat([a, ACK_GAP, rest]); this.composed++; }
        break;
      }
    }
    if (buf) this.hits++; else this.misses++;
    return buf;
  }

  has(text) { const k = String(text || '').trim(); return this.fixed.has(k) || this.dynamic.has(k); }

  remember(text, buf) {
    const key = String(text || '').trim();
    if (!key || !buf || !buf.length || this.fixed.has(key)) return;
    this.dynamic.set(key, buf);
    while (this.dynamic.size > this.maxDynamic) this.dynamic.delete(this.dynamic.keys().next().value);
  }

  diskPath(text) {
    if (!this.diskKey) return null;
    const h = crypto.createHash('sha1').update(`${this.diskKey}
${text}`).digest('hex');
    return path.join(CACHE_DIR, `${h}.ulaw`);
  }

  readDisk(text) {
    const p = this.diskPath(text);
    if (!p) return null;
    try { const b = fs.readFileSync(p); return b.length ? b : null; } catch (_) { return null; }
  }

  writeDisk(text, buf) {
    const p = this.diskPath(text);
    if (!p || !buf || !buf.length) return;
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(p, buf); } catch (_) { /* best effort */ }
  }

  /** One render, done again (up to RENDER_RETRIES times) when it comes out stretched; the shortest take wins. */
  async renderChecked(text, log = console.log) {
    let best = await this.tts.render(text);
    for (let i = 0; i < RENDER_RETRIES && looksStretched(text, best); i++) {
      log(`⚠️ Prompt cache: "${text.slice(0, 40)}..." rendered ${(best.length / 8000).toFixed(1)} s for ${text.length} chars - rendering again`);
      this.stretched = (this.stretched || 0) + 1;
      const again = await this.tts.render(text);
      if (again.length && again.length < best.length) best = again;
    }
    return best;
  }

  /** Render every fixed prompt through the TTS provider, a few at a time. */
  async warm(prompts = collectFixedPrompts(), { concurrency = 2, log = console.log } = {}) {
    const t0 = Date.now();
    const queue = [...prompts];
    const worker = async () => {
      while (queue.length) {
        const text = queue.shift();
        const onDisk = this.readDisk(text);
        if (onDisk && !looksStretched(text, onDisk)) { this.fixed.set(text, onDisk); this.seconds += onDisk.length / 8000; this.fromDisk++; continue; }
        if (onDisk) log(`⚠️ Prompt cache: the stored render of "${text.slice(0, 40)}..." is ${(onDisk.length / 8000).toFixed(1)} s for ${text.length} chars - rendering it again`);
        try {
          const buf = await this.renderChecked(text, log);
          if (buf.length) { this.fixed.set(text, buf); this.seconds += buf.length / 8000; this.writeDisk(text, buf); }
          else this.failed++;
        } catch (err) {
          this.failed++;
          // One line for the first two, then only the summary: a dead provider
          // fails all 58 the same way.
          if (this.failed <= 2) log(`⚠️ Prompt cache: could not render "${text.slice(0, 40)}...": ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
    this.ready = true;
    log(`🗂️ Prompt cache ready: ${this.fixed.size}/${prompts.length} prompts, ${this.seconds.toFixed(1)} s of audio, ${this.fromDisk} from disk, ${((Date.now() - t0) / 1000).toFixed(1)} s${this.failed ? `, ${this.failed} failed` : ''}`);
    return this;
  }

  /** Forget everything (used when switching the whole process to another voice). */
  reset() {
    this.fixed.clear();
    this.dynamic.clear();
    this.ready = false;
    this.failed = 0;
    this.seconds = 0;
    this.fromDisk = 0;
  }

  summary() {
    return { ready: this.ready, fixed: this.fixed.size, dynamic: this.dynamic.size, seconds: Math.round(this.seconds), from_disk: this.fromDisk, hits: this.hits, composed: this.composed, misses: this.misses, failed: this.failed, stretched: this.stretched || 0 };
  }
}

module.exports = { PromptCache, collectFixedPrompts, ACKNOWLEDGEMENTS, ACK_GAP_MS, expectedSeconds, looksStretched };
