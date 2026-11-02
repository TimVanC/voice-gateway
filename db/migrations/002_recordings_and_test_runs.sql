-- Recordings and test-caller runs, attached to rows in `calls`.
--
-- recordings: the audio of a call, one row per call. Written today only by
-- the test-caller harness (scripts/test-caller), which hears both sides of
-- the call it places. Audio is kept exactly as it travelled on the Twilio
-- media stream: 8 kHz G.711 mu-law, one byte per sample, one column per
-- side (8 KB per second per side, about 2 MB per side for a 4 minute call).
-- The web app decodes it to a stereo WAV on request (caller left, Ava
-- right), so nothing is transcoded at write time.
--
-- test_runs: what the harness measured and checked on that call: scenario,
-- pass/fail, turn latency, dead air, barge-ins, and the full report JSON.
--
-- Apply with: node scripts/db-migrate.js   (reads DATABASE_URL from .env)

CREATE TABLE IF NOT EXISTS recordings (
  id                BIGSERIAL PRIMARY KEY,
  call_id           BIGINT NOT NULL UNIQUE REFERENCES calls (id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'test-caller',
  codec             TEXT NOT NULL DEFAULT 'pcmu',   -- G.711 mu-law
  sample_rate       INTEGER NOT NULL DEFAULT 8000,
  duration_seconds  NUMERIC(8, 1),
  caller_audio      BYTEA NOT NULL,                 -- what the caller said
  ava_audio         BYTEA NOT NULL,                 -- what Ava said, same time base
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id                 BIGSERIAL PRIMARY KEY,
  call_id            BIGINT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  scenario           TEXT NOT NULL,
  mode               TEXT NOT NULL,                 -- local | phone
  passed             BOOLEAN NOT NULL,
  outcome_expected   TEXT,                          -- confirmation | out_of_scope | transfer
  outcome_reached    BOOLEAN,
  ended_how          TEXT,
  latency_p50_ms     INTEGER,
  latency_p90_ms     INTEGER,
  latency_max_ms     INTEGER,
  dead_air_max_ms    INTEGER,
  dead_air_gaps      INTEGER,                       -- gaps of 3 s or more
  barge_ins          INTEGER,
  interjections      INTEGER,
  report             JSONB NOT NULL,                -- the run's report.json
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_runs_call_id_idx ON test_runs (call_id);
CREATE INDEX IF NOT EXISTS test_runs_scenario_idx ON test_runs (scenario, created_at DESC);
