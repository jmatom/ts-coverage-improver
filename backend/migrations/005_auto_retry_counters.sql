-- 005 — bounded auto-retry counters for crash recovery
--
-- A job/analysis row in `running` state at boot was, by definition, interrupted
-- (no work is allowed to be `running` while the process isn't alive). The
-- boot reconciler can therefore safely auto-retry such rows once. The counter
-- below caps that to a single automatic retry to avoid boot-looping the
-- system on a poison job that always crashes the backend.
--
-- Reset semantics:
--   - improvement_jobs.auto_retry_count is per-row; each new "Improve" click
--     creates a fresh row, so the budget is naturally fresh per attempt.
--   - repositories.analysis_auto_retry_count lives on the long-lived repo
--     aggregate and is reset to 0 whenever the user manually re-requests
--     analysis (so each manual request gets its own auto-retry budget).
ALTER TABLE improvement_jobs
  ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE repositories
  ADD COLUMN analysis_auto_retry_count INTEGER NOT NULL DEFAULT 0;
