/**
 * Post-call data cleanup using Claude AI.
 * Runs after intake is complete to fix common data quality issues
 * before writing to Google Sheets.
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function cleanCallData(data) {
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
      model: 'claude-sonnet-4-20250514',
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

module.exports = { cleanCallData };
