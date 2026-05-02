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
   * Mark any `running` job as `failed`. Called once at boot — if a row is
   * still `running` after process start, the worker must have died mid-job.
   * Returns the number of rows reconciled.
   */
  reconcileOrphanRunningJobs(reason = 'process restarted mid-execution'): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE improvement_jobs
            SET status = 'failed',
                error = ?,
                completed_at = ?
          WHERE status = 'running'`,
      )
      .run(reason, now);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
