/**
 * One short model call that returns JSON matching a schema. Used by the relay
 * brain (src/relay-brain.js) to read a caller's turn into fields.
 *
 *   const extractor = createExtractor();                    // anthropic when ANTHROPIC_API_KEY is set, else openai
 *   const obj = await extractor.extract({ system, user, schema, timeoutMs: 3500 });
 *
 * Speed is the point: this runs on most caller turns of a live phone call, so
 * the default models are the small fast ones (Claude Haiku 5.5, gpt-4o-mini),
 * the output is a few dozen tokens, and there are no retries inside the call.
 * RELAY_BRAIN_MODEL / RELAY_BRAIN_PROVIDER override the choice. When the
 * first provider fails and the other one has a key, that one is tried once.
 */

class AnthropicExtractor {
  constructor({ apiKey, model = 'claude-haiku-5-5' }) {
    const Anthropic = require('@anthropic-ai/sdk');
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
    this.model = model;
    this.usage = { input: 0, output: 0, calls: 0, cacheRead: 0 };
  }
  get name() { return `anthropic:${this.model}`; }
  async extract({ system, user, schema, timeoutMs = 3500, maxTokens = 400 }) {
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      // The instructions never change during a call: cache them.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    };
    // Reading one sentence into fields needs no deliberation; Haiku accepts thinking off at this effort.
    if (/haiku/.test(this.model)) params.thinking = { type: 'disabled' };
    const res = await this.client.messages.create(params, { timeout: timeoutMs });
    this.usage.calls++;
    if (res.usage) {
      this.usage.input += res.usage.input_tokens || 0;
      this.usage.output += res.usage.output_tokens || 0;
      this.usage.cacheRead += res.usage.cache_read_input_tokens || 0;
    }
    if (res.stop_reason === 'refusal') throw new Error('extractor refused');
    const block = (res.content || []).find((b) => b.type === 'text');
    if (!block) throw new Error(`extractor returned no text (stop_reason ${res.stop_reason})`);
    return JSON.parse(block.text);
  }
}

class OpenAiExtractor {
  constructor({ apiKey, model = 'gpt-4o-mini' }) {
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
    this.model = model;
    this.usage = { input: 0, output: 0, calls: 0, cacheRead: 0 };
  }
  get name() { return `openai:${this.model}`; }
  async extract({ system, user, schema, timeoutMs = 3500, maxTokens = 400 }) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'caller_turn', strict: true, schema } },
    }, { timeout: timeoutMs });
    this.usage.calls++;
    if (res.usage) { this.usage.input += res.usage.prompt_tokens || 0; this.usage.output += res.usage.completion_tokens || 0; }
    const text = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if (!text) throw new Error('extractor returned no content');
    return JSON.parse(text);
  }
}

/** Tries the first extractor; on any failure the second one, once. */
class FallbackExtractor {
  constructor(primary, secondary) { this.primary = primary; this.secondary = secondary; this.fallbacks = 0; }
  get name() { return this.secondary ? `${this.primary.name} (fallback ${this.secondary.name})` : this.primary.name; }
  get usage() { return this.primary.usage; }
  async extract(args) {
    try {
      return await this.primary.extract(args);
    } catch (err) {
      if (!this.secondary) throw err;
      this.fallbacks++;
      console.warn(`⚠️ Extractor ${this.primary.name} failed (${err.message}); trying ${this.secondary.name}`);
      return this.secondary.extract(args);
    }
  }
}

function createExtractor({ env = process.env } = {}) {
  const want = (env.RELAY_BRAIN_PROVIDER || '').trim().toLowerCase();
  const model = (env.RELAY_BRAIN_MODEL || '').trim() || undefined;
  const anthropic = env.ANTHROPIC_API_KEY ? () => new AnthropicExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: want === 'openai' ? undefined : model }) : null;
  const openai = env.OPENAI_API_KEY ? () => new OpenAiExtractor({ apiKey: env.OPENAI_API_KEY, model: want === 'openai' || !anthropic ? model : undefined }) : null;
  const order = want === 'openai' ? [openai, anthropic] : [anthropic, openai];
  const made = order.filter(Boolean).map((f) => f());
  if (!made.length) throw new Error('no ANTHROPIC_API_KEY or OPENAI_API_KEY for the extractor');
  return new FallbackExtractor(made[0], made[1] || null);
}

module.exports = { createExtractor, AnthropicExtractor, OpenAiExtractor, FallbackExtractor };
