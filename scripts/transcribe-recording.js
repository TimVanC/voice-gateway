#!/usr/bin/env node
/**
 * Take a call's transcript from its recording (src/utils/recording-transcript.js).
 *
 *   node scripts/transcribe-recording.js --call 2716            print what the recording says
 *   node scripts/transcribe-recording.js --call 2716 --write    and make it the call's transcript
 *   node scripts/transcribe-recording.js --call 2716 --wav call-2716.wav   use a downloaded WAV (caller left, Ava right)
 *
 * Needs DATABASE_URL and DEEPGRAM_API_KEY. The server does this by itself after every recorded relay call.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true, path: path.join(__dirname, '..', '.env') });
const db = require('../src/utils/call-db');
const { parseWav } = require('../src/utils/twilio-recording');
const { muLawToPcm16 } = require('../src/g711');
const { stereoWav, transcribeWav, buildHeardTurns } = require('../src/utils/recording-transcript');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };

(async () => {
  const callRowId = Number(arg('call'));
  if (!callRowId) throw new Error('Give --call <id>');
  let caller;
  let ava;
  if (arg('wav')) {
    const { channels } = parseWav(fs.readFileSync(arg('wav')));
    [caller, ava] = channels;
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const r = await pool.query('SELECT caller_audio, ava_audio FROM recordings WHERE call_id = $1', [callRowId]);
    await pool.end();
    if (!r.rows[0]) throw new Error(`No recording stored for call ${callRowId}`);
    caller = muLawToPcm16(r.rows[0].caller_audio);
    ava = muLawToPcm16(r.rows[0].ava_audio);
  }
  const serverTurns = await db.getTranscriptTurns(callRowId);
  if (serverTurns === null) throw new Error('Could not read the call');
  const utterances = await transcribeWav(stereoWav(caller, ava));
  const turns = buildHeardTurns(utterances, serverTurns);
  for (const t of turns) console.log(`${t.at.toISOString().slice(11, 19)} ${t.speaker === 'ava' ? 'AVA   ' : 'CALLER'} ${t.text}`);
  if (process.argv.includes('--write')) {
    const saved = await db.replaceTranscriptFromRecording(callRowId, turns, serverTurns);
    console.log(saved.success ? `\nStored as the transcript of call ${callRowId} (${turns.length} turns).` : `\nNot stored: ${saved.error || 'skipped'}`);
  }
  if (db.closePool) await db.closePool();
})().catch((e) => { console.error(e.message); process.exit(1); });
