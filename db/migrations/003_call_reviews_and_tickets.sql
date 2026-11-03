-- Call reviews and tickets.
--
-- call_reviews: one row per reviewed call, written by src/review/call-reviewer.js
-- (CALL_REVIEW=on): the model's verdict, a one-line summary and the findings
-- (discrepancies between what the script requires and what happened).
--
-- tickets: one row per underlying problem, keyed by a fingerprint
-- (category:key) so the same bug seen on ten calls is one ticket with ten
-- occurrences, not ten tickets. Marking a ticket fixed and seeing it again
-- reopens it; an ignored ticket stays ignored.
--
-- ticket_calls: which calls showed which ticket, with that call's finding.
--
-- Apply with: node scripts/db-migrate.js   (reads DATABASE_URL from .env)

CREATE TABLE IF NOT EXISTS call_reviews (
  id             BIGSERIAL PRIMARY KEY,
  call_id        BIGINT NOT NULL UNIQUE REFERENCES calls (id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  verdict        TEXT NOT NULL,                 -- clean | issues | skipped | error
  summary        TEXT,
  findings       JSONB NOT NULL DEFAULT '[]',
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id             BIGSERIAL PRIMARY KEY,
  fingerprint    TEXT NOT NULL UNIQUE,          -- category:key
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL,                 -- high | medium | low (highest seen)
  title          TEXT NOT NULL,
  detail         TEXT,                          -- expected behaviour, from the first finding
  fix_area       TEXT,
  status         TEXT NOT NULL DEFAULT 'open',  -- open | fixed | ignored
  occurrences    INTEGER NOT NULL DEFAULT 1,
  first_call_id  BIGINT REFERENCES calls (id) ON DELETE SET NULL,
  last_call_id   BIGINT REFERENCES calls (id) ON DELETE SET NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  reopened_at    TIMESTAMPTZ,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ticket_calls (
  ticket_id   BIGINT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  call_id     BIGINT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  finding     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, call_id)
);

CREATE INDEX IF NOT EXISTS ticket_calls_call_id_idx ON ticket_calls (call_id);
