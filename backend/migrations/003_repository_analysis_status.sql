-- Track per-repository analysis lifecycle so re-analyze can return immediately
-- (HTTP 202) and the dashboard can poll for completion.
--
-- Status state machine:
--   idle      → starting state; also the terminal state after a successful analysis
--   pending   → user requested re-analyze; queued but not yet picked up by the worker
--   running   → worker has started; clone + install + tests in progress
--   failed    → last attempt failed; analysis_error has the reason
--
-- A successful run transitions running → idle (and updates last_analyzed_at).
-- A failure transitions running → failed (and writes analysis_error).
-- A new request from any state transitions → pending (overriding stale failed state).
ALTER TABLE repositories ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'idle'
  CHECK (analysis_status IN ('idle','pending','running','failed'));
ALTER TABLE repositories ADD COLUMN analysis_error TEXT;
ALTER TABLE repositories ADD COLUMN analysis_started_at TEXT;
