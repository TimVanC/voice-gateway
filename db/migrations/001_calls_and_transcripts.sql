-- Ava call records: one row per call plus its transcript.
--
-- Written by src/utils/call-db.js alongside (never instead of) the Google
-- Sheets logger. The intake columns mirror COLUMN_HEADERS in
-- src/utils/google-sheets-logger.js one for one, so a Neon row and a Sheet
-- row for the same call carry the same values.
--
-- Apply with: node scripts/db-migrate.js   (reads DATABASE_URL from .env)

CREATE TABLE IF NOT EXISTS calls (
  id                 BIGSERIAL PRIMARY KEY,

  -- Identity. call_id is the same value as the Sheet's call_id column
  -- (the Twilio media-stream SID, "MZ..."); twilio_call_sid is the voice
  -- call SID ("CA...") and is only known for calls written by the server.
  call_id            TEXT NOT NULL UNIQUE,
  twilio_call_sid    TEXT,

  -- Provenance.
  --   source:      'server' = written live by src/server-rse.js
  --                'sheets' = imported by scripts/migrate-sheets-to-neon.js
  --   environment: Railway environment name (production, staging) or 'local'
  source             TEXT NOT NULL DEFAULT 'server',
  environment        TEXT,
  sheet_row_number   INTEGER,

  -- Flags. is_test marks calls from RSE's own numbers or obvious test
  -- content; test_reason says why. pre_caller_id_fix marks imported rows
  -- from before caller ID was passed through (every such row shows RSE's
  -- own number, so the phone column says nothing about who called).
  is_test            BOOLEAN NOT NULL DEFAULT FALSE,
  test_reason        TEXT,
  pre_caller_id_fix  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Telephony.
  direction          TEXT NOT NULL DEFAULT 'inbound',
  caller_number      TEXT,            -- raw caller ID from Twilio (E.164)
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ,
  duration_seconds   INTEGER,

  -- Intake fields, identical to the Sheet columns of the same name.
  first_name         TEXT,
  last_name          TEXT,
  conf_name          SMALLINT,
  phone_number       TEXT,
  conf_pn            SMALLINT,
  conf_mail          SMALLINT,
  email              TEXT,
  primary_intent     TEXT,
  conf_add           SMALLINT,
  service_address    TEXT,
  conf_avail         SMALLINT,
  availability_notes TEXT,
  call_summary       TEXT,
  call_status        TEXT,

  -- Extra context the Sheet does not keep.
  final_state        TEXT,            -- state machine state at hang-up
  was_transferred    BOOLEAN,
  is_safety_risk     BOOLEAN,
  intake_json        JSONB,           -- full cleaned intake object (details etc.)

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_started_at_idx ON calls (started_at DESC);
CREATE INDEX IF NOT EXISTS calls_caller_number_idx ON calls (caller_number);
CREATE INDEX IF NOT EXISTS calls_phone_number_idx ON calls (phone_number);
CREATE INDEX IF NOT EXISTS calls_is_test_idx ON calls (is_test);

CREATE TABLE IF NOT EXISTS transcript_turns (
  id        BIGSERIAL PRIMARY KEY,
  call_id   BIGINT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  sequence  INTEGER NOT NULL,
  speaker   TEXT NOT NULL CHECK (speaker IN ('caller', 'ava')),
  text      TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  UNIQUE (call_id, sequence)
);

CREATE INDEX IF NOT EXISTS transcript_turns_call_id_idx ON transcript_turns (call_id);
