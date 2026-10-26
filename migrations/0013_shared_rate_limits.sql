-- Rate-limit counters shared by every server instance (serverless functions each
-- have their own memory, so in-memory counters multiply the real limit by the
-- number of warm instances). Keys are one-way hashes: no address or e-mail is stored.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key varchar PRIMARY KEY,
  hits integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_reset_idx ON rate_limit_hits (reset_at);
