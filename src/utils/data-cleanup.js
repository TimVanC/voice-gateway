/**
 * Post-call data cleanup using Claude AI.
 * Runs after intake is complete to fix common data quality issues
 * before writing to Google Sheets.
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// House numbers the transcriber wrote as words ("Fourteen Elm Street",
// "One twenty three Main St"): the Sheet's address check only accepts a
// street address that starts with digits, so these were saved with no
// service address at all. Converted here, before the Sheet and Neon.
const UNIT_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function wordsToHouseNumber(words) {
  if (words.includes('hundred') || words.includes('thousand')) {
    let total = 0;
    let current = 0;
    for (const w of words) {
      if (w in UNIT_WORDS) current += UNIT_WORDS[w];
      else if (w in TENS_WORDS) current += TENS_WORDS[w];
      else if (w === 'hundred') current = (current || 1) * 100;
      else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
    }
    return String(total + current);
  }
  // Spoken in groups: "one twenty three" -> 1|23, "eighty eight" -> 88.
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS_WORDS) {
      const next = words[i + 1];
      if (next in UNIT_WORDS && UNIT_WORDS[next] > 0 && UNIT_WORDS[next] < 10) {
        out += String(TENS_WORDS[w] + UNIT_WORDS[next]);
        i++;
      } else {
        out += String(TENS_WORDS[w]);
      }
    } else {
      out += String(UNIT_WORDS[w]);
    }
  }
  return out;
}

function normalizeHouseNumber(address) {
  if (!address || typeof address !== 'string') return address;
  const isNumberWord = (w) => w in UNIT_WORDS || w in TENS_WORDS || w === 'hundred' || w === 'thousand';
  const tokens = address.trim().split(/\s+/);
  const run = [];
  let consumed = 0;
  for (const tok of tokens) {
    const parts = tok.toLowerCase().replace(/[.,]+$/, '').split('-');
    if (!parts.every(isNumberWord)) break;
    run.push(...parts);
    consumed++;
  }
  if (!run.length || run[0] === 'oh' || run[0] === 'hundred' || run[0] === 'thousand') return address;
  const rest = tokens.slice(consumed).join(' ');
  if (!/[a-z]/i.test(rest)) return address; // only a number: leave it
  return `${wordsToHouseNumber(run)} ${rest}`;
}

async function cleanCallData(data) {
  if (data && data.address) {
    const fixed = normalizeHouseNumber(data.address);
    if (fixed !== data.address) {
      console.log(`🏠 House number written as words: "${data.address}" -> "${fixed}"`);
      data = { ...data, address: fixed };
    }
  }
  // Only run on calls with at least some data worth cleaning
  const hasAnything = data.firstName || data.lastName || data.availability || data.situationSummary;
  if (!hasAnything) return data;

  const prompt = `You are a data quality assistant for an HVAC company call center. 
Review this call intake data and fix any errors. Return ONLY a valid JSON object with the corrected fields.

Rules:
- Fix name splitting errors: if first_name and last_name look like the same name concatenated (e.g. first="Tex" last="Texjohnson"), correct them (first="Tex" last="Johnson")
- If only one name field is populated and it contains a full name, split it correctly
- Clean availability_notes: remove filler words, question marks, uncertainty language. Make it concise (e.g. "Monday through Friday, 9am to 5pm")
- Clean call_summary: make it specific and concise, remove generic phrases like "Caller reported", remove trailing punctuation issues. Max 10 words.
- Do not invent or assume data that wasn't collected
- If a field looks correct, return it unchanged
- Return null for fields that are empty or clearly wrong

Input data:
${JSON.stringify({
  first_name: data.firstName,
  last_name: data.lastName,
  availability_notes: data.availability,
  call_summary: data.situationSummary
}, null, 2)}

Return ONLY this JSON structure with no preamble or markdown:
{
  "first_name": "...",
  "last_name": "...",
  "availability_notes": "...",
  "call_summary": "..."
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const cleaned = JSON.parse(text);

    console.log(`🧹 Data cleanup applied:`, JSON.stringify(cleaned));

    return {
      ...data,
      firstName: cleaned.first_name ?? data.firstName,
      lastName: cleaned.last_name ?? data.lastName,
      availability: cleaned.availability_notes ?? data.availability,
      situationSummary: cleaned.call_summary ?? data.situationSummary
    };

  } catch (err) {
    console.error('⚠️ Data cleanup failed, using original data:', err.message);
    return data;
  }
}

module.exports = { cleanCallData, normalizeHouseNumber };
