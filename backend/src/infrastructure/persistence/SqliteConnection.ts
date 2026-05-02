import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Thin wrapper around the built-in `node:sqlite` driver.
 *
 * Boot responsibilities:
 *   1. Open / create the DB file (and parent dir).
 *   2. Enable foreign keys.
 *   3. Apply pending migrations from the supplied directory in lexical order.
 *   4. Reconcile orphan `running` jobs as `failed` with a clear reason —
 *      this honors the plan's restart-recovery rule.
 *
 * Migrations are tracked in a `_migrations` table, keyed by filename. SQL
 * files are applied as-is (multi-statement), so they can include `CREATE
 * TABLE`, indexes, triggers — anything `db.exec` accepts.
 */
export class SqliteConnection {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
  }

  applyMigrations(migrationsDir: string): readonly string[] {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);',
    );
    const rows = this.db
      .prepare('SELECT filename FROM _migrations')
      .all() as unknown as { filename: string }[];
    const applied = new Set(rows.map((r) => r.filename));
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const newlyApplied: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(migrationsDir, f), 'utf8');
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(f);
        this.db.exec('COMMIT');
        newlyApplied.push(f);
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return newlyApplied;
  }

  /**
   * Boot-time crash recovery for improvement jobs.
   *
   * Invariant: a row with `status = 'running'` at process boot was, by
   * definition, interrupted — no work is allowed to be `running` while the
   * process isn't alive. This holds for both `kill -9` and graceful shutdown.
   *
   * Two-pass behavior:
   *   1. Auto-retry pass — rows with `auto_retry_count < 1` are flipped back
   *      to `pending` (started_at cleared, counter incremented). The
   *      `RecoverPendingWork` use case re-enqueues them right after.
   *   2. Hard-fail pass — rows that have already been auto-retried once are
   *      marked `failed` so a poison job can't boot-loop the system.
   *
   * Returns counts so the boot logger can surface what happened.
   */
  reconcileOrphanRunningJobs(): { requeued: number; failed: number } {
    // Pass 1: under-budget → re-pending
    const requeueRes = this.db
      .prepare(
        `UPDATE improvement_jobs
            SET status = 'pending',
                started_at = NULL,
                auto_retry_count = auto_retry_count + 1
          WHERE status = 'running' AND auto_retry_count < 1`,
      )
      .run();

    // Pass 2: budget exhausted → terminal failure
    const now = new Date().toISOString();
    const failRes = this.db
      .prepare(
        `UPDATE improvement_jobs
            SET status = 'failed',
                error = ?,
                completed_at = ?
          WHERE status = 'running'`,
      )
      .run(
        'process restarted mid-execution; auto-retry budget exhausted',
        now,
      );

    return { requeued: Number(requeueRes.changes), failed: Number(failRes.changes) };
  }

  /**
   * Same boot-time crash recovery for `repositories.analysis_status`. Mirror
   * of `reconcileOrphanRunningJobs` for the analysis lifecycle: under-budget
   * rows are flipped to `pending` (so `RecoverPendingWork` re-enqueues them),
   * over-budget rows are marked `failed` for the user to retry manually.
   *
   * Crucially, this only targets `running` rows — NOT `pending` ones. A
   * `pending` row was enqueued but never picked up by a worker; the right
   * action is to re-enqueue it, which `RecoverPendingWork` handles.
   */
  reconcileOrphanRunningAnalyses(): { requeued: number; failed: number } {
    const requeueRes = this.db
      .prepare(
        `UPDATE repositories
            SET analysis_status = 'pending',
                analysis_started_at = NULL,
                analysis_error = NULL,
                analysis_auto_retry_count = analysis_auto_retry_count + 1
          WHERE analysis_status = 'running' AND analysis_auto_retry_count < 1`,
      )
      .run();

    const failRes = this.db
      .prepare(
        `UPDATE repositories
            SET analysis_status = 'failed',
                analysis_error = ?
          WHERE analysis_status = 'running'`,
      )
      .run(
        'process restarted mid-analysis; auto-retry budget exhausted — please re-analyze',
      );

    return { requeued: Number(requeueRes.changes), failed: Number(failRes.changes) };
  }

  close(): void {
    this.db.close();
  }
}
