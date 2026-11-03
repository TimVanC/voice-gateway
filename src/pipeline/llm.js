/**
 * The language model for the free-form parts of the call (the scripted
 * prompts never go through it). Streams text and hands it over sentence by
 * sentence so TTS can start on the first sentence while the second is still
 * being written.
 *
 *   const llm = createLlm();           // anthropic when ANTHROPIC_API_KEY is set, else openai
 *   const text = await llm.reply({ system, messages, onSentence: (s) => ..., maxTokens: 160 });
 *
 * Providers: anthropic (Claude Sonnet, LLM_MODEL default claude-sonnet-5-5,
 * effort low: a two-sentence receptionist reply does not need deliberation)
 * and openai (chat completions, LLM_MODEL default gpt-4o-mini).
 */

/** Split a stream of text deltas into sentences; the tail is flushed by end(). */
function createSentenceSplitter(onSentence) {
  let buf = '';
  const ABBREV = /\b(mr|mrs|ms|dr|st|no|vs|etc|e\.g|i\.e)\.$/i;
  return {
    push(delta) {
      buf += delta;
      for (;;) {
        const m = buf.match(/^(.*?[.!?]+)(?=\s)(\s+)/s);
        if (!m) break;
        const candidate = m[1];
        if (ABBREV.test(candidate.trim()) || candidate.trim().length < 12) {
          // Too short to be a sentence of its own ("Okay." merges with the next one).
          const rest = buf.slice(m[0].length);
          const next = rest.match(/^(.*?[.!?]+)(?=\s|$)/s);
          if (!next) break;
          buf = buf.slice(m[0].length + next[0].length);
          onSentence(`${candidate} ${next[1]}`.trim());
          continue;
        }
        buf = buf.slice(m[0].length);
        onSentence(candidate.trim());
      }
    },
    end() {
      const t = buf.trim();
      buf = '';
      if (t) onSentence(t);
    },
  };
}

class AnthropicLlm {
  constructor({ apiKey, model = 'claude-sonnet-5-5' }) {
    const Anthropic = require('@anthropic-ai/sdk');
    this.client = new Anthropic({ apiKey, timeout: 20000, maxRetries: 1 });
    this.model = model;
    this.usage = { input: 0, output: 0, calls: 0 };
  }
  get name() { return `anthropic:${this.model}`; }
  async reply({ system, messages, onSentence, maxTokens = 160 }) {
    const split = createSentenceSplitter(onSentence);
    let full = '';
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      system,
      output_config: { effort: 'low' },
      messages,
    });
    stream.on('text', (delta) => { full += delta; split.push(delta); });
    const final = await stream.finalMessage();
    split.end();
    this.usage.calls++;
    if (final.usage) { this.usage.input += final.usage.input_tokens || 0; this.usage.output += final.usage.output_tokens || 0; }
    return full.trim();
  }
}

class OpenAiLlm {
  constructor({ apiKey, model = 'gpt-4o-mini' }) {
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey, timeout: 20000, maxRetries: 1 });
    this.model = model;
    this.usage = { input: 0, output: 0, calls: 0 };
  }
  get name() { return `openai:${this.model}`; }
  async reply({ system, messages, onSentence, maxTokens = 160 }) {
    const split = createSentenceSplitter(onSentence);
    let full = '';
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: system }, ...messages],
    });
    for await (const chunk of stream) {
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (delta) { full += delta; split.push(delta); }
      if (chunk.usage) { this.usage.input += chunk.usage.prompt_tokens || 0; this.usage.output += chunk.usage.completion_tokens || 0; }
    }
    split.end();
    this.usage.calls++;
    return full.trim();
  }
}

function resolveLlmProvider(env = process.env) {
  const want = (env.LLM_PROVIDER || '').trim().toLowerCase();
  if (want === 'anthropic' || (!want && env.ANTHROPIC_API_KEY)) return 'anthropic';
  if (want === 'openai' || !want) return 'openai';
  throw new Error(`Unknown LLM_PROVIDER "${want}" (anthropic | openai)`);
}

function createLlm({ provider, env = process.env } = {}) {
  const p = provider || resolveLlmProvider(env);
  if (p === 'anthropic') return new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL || 'claude-sonnet-5-5' });
  return new OpenAiLlm({ apiKey: env.OPENAI_API_KEY, model: env.LLM_MODEL || 'gpt-4o-mini' });
}

module.exports = { createLlm, resolveLlmProvider, createSentenceSplitter, AnthropicLlm, OpenAiLlm };
