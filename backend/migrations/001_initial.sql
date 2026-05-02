-- 001 — initial schema
-- Repositories tracked by the system, the coverage scans we've run,
-- and the improvement jobs that target their low-coverage files.

CREATE TABLE repositories (
  id                TEXT PRIMARY KEY,
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  default_branch    TEXT NOT NULL,
  fork_owner        TEXT,
  last_analyzed_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner, name)
);

CREATE TABLE coverage_reports (
  id              TEXT PRIMARY KEY,
  repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha      TEXT NOT NULL,
  generated_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_coverage_reports_repo_generated
  ON coverage_reports (repository_id, generated_at DESC);

CREATE TABLE file_coverages (
  report_id        TEXT NOT NULL REFERENCES coverage_reports(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  lines_pct        REAL NOT NULL,
  branches_pct     REAL,
  functions_pct    REAL,
  statements_pct   REAL,
  uncovered_lines  TEXT NOT NULL,  -- JSON array of line numbers
  PRIMARY KEY (report_id, path)
);

CREATE TABLE improvement_jobs (
  id                TEXT PRIMARY KEY,
  repository_id     TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  target_file_path  TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  mode              TEXT CHECK (mode IS NULL OR mode IN ('append','sibling')),
  pr_url            TEXT,
  coverage_before   REAL,
  coverage_after    REAL,
  error             TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT
);

CREATE INDEX idx_improvement_jobs_repo
  ON improvement_jobs (repository_id, created_at DESC);

CREATE INDEX idx_improvement_jobs_status
  ON improvement_jobs (status);

CREATE TABLE job_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES improvement_jobs(id) ON DELETE CASCADE,
  line       TEXT NOT NULL,
  logged_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_job_logs_job ON job_logs (job_id, id);
