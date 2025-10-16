// lib/rag.js
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class MiniRAG {
  constructor({ kbDir = "./kb", threshold = 0.82 } = {}) {
    this.kbDir = kbDir;
    this.threshold = threshold;
    this.docs = [];      // { id, title, text, embedding }
  }

  async load() {
    if (!fs.existsSync(this.kbDir)) {
      console.log(`⚠️  KB directory ${this.kbDir} not found, skipping RAG`);
      return;
    }
    
    const files = fs.readdirSync(this.kbDir).filter(f => f.endsWith(".md"));
    if (files.length === 0) {
      console.log(`⚠️  No .md files in ${this.kbDir}, skipping RAG`);
      return;
    }
    
    const texts = files.map(f => {
      const p = path.join(this.kbDir, f);
      const t = fs.readFileSync(p, "utf8");
      return { id: f, title: f.replace(/\.md$/,""), text: t };
    });
    
    console.log(`📚 Loading ${texts.length} KB documents for RAG...`);
    
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: texts.map(t => t.text.slice(0, 4000))
    });
    
    this.docs = texts.map((t, i) => ({ ...t, embedding: emb.data[i].embedding }));
    console.log(`✅ RAG loaded with ${this.docs.length} documents`);
  }

  async search(query, topK = 3) {
    if (this.docs.length === 0) return [];
    
    const q = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query
    });
    
    const qe = q.data[0].embedding;
    const scored = this.docs.map(d => ({ ...d, score: cosine(d.embedding, qe) }))
                            .sort((a,b)=>b.score-a.score)
                            .slice(0, topK);
    return scored;
  }

  isHit(score) {
    return score >= this.threshold;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { 
    dot += a[i]*b[i]; 
    na += a[i]*a[i]; 
    nb += b[i]*b[i]; 
  }
  return dot / (Math.sqrt(na)*Math.sqrt(nb));
}

async function summarize(doc, question) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Answer using the provided context only. Be concise and conversational." },
      { role: "user", content: `Context:\n${doc}\n\nQuestion: ${question}` }
    ]
  });
  return r.choices[0].message.content.trim();
}

module.exports = { MiniRAG, summarize };

