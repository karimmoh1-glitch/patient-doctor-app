-- Scheduler reliability: a lease so two overlapping runs can never both execute
-- (or overwrite each other's outcome), and a bounded per-run history so
-- "has the scheduler really been calling us every five minutes?" is answerable
-- from data rather than from a workflow file.

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS lease_run_id varchar;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;

CREATE TABLE IF NOT EXISTS job_run_history (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  job varchar NOT NULL,
  run_id varchar NOT NULL,
  -- Who called: "github-actions", "cloudflare-worker", "vercel-cron", ... Informational
  -- only (the caller names itself); never used for any security decision.
  source varchar NOT NULL DEFAULT 'unknown',
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  -- running | ok | failed | skipped_overlap | superseded
  outcome varchar NOT NULL DEFAULT 'running',
  duration_ms integer,
  error varchar,
  -- Counts only. Never names, addresses or medicines.
  result jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS job_run_history_job_started_idx ON job_run_history (job, started_at DESC);
