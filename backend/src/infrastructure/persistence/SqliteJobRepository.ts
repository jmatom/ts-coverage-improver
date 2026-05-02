import { DatabaseSync } from 'node:sqlite';
import { ImprovementJob } from '@domain/job/ImprovementJob';
import { ImprovementMode, JobStatus } from '@domain/job/JobStatus';
import { JobRepository } from '@domain/ports/JobRepository';

interface Row {
  id: string;
  repository_id: string;
  target_file_path: string;
  status: string;
  mode: string | null;
  pr_url: string | null;
  coverage_before: number | null;
  coverage_after: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(job: ImprovementJob): Promise<void> {
    const p = job.toPlain();
    this.db
      .prepare(
        `INSERT INTO improvement_jobs
           (id, repository_id, target_file_path, status, mode, pr_url,
            coverage_before, coverage_after, error,
            created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           mode = excluded.mode,
           pr_url = excluded.pr_url,
           coverage_before = excluded.coverage_before,
           coverage_after = excluded.coverage_after,
           error = excluded.error,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        p.id,
        p.repositoryId,
        p.targetFilePath,
        p.status,
        p.mode,
        p.prUrl,
        p.coverageBefore,
        p.coverageAfter,
        p.error,
        p.createdAt.toISOString(),
        p.startedAt ? p.startedAt.toISOString() : null,
        p.completedAt ? p.completedAt.toISOString() : null,
      );
  }

  async findById(id: string): Promise<ImprovementJob | null> {
    const row = this.db.prepare('SELECT * FROM improvement_jobs WHERE id = ?').get(id) as
      | unknown
      | undefined;
    return row ? this.fromRow(row as Row) : null;
  }

  async listByRepository(repositoryId: string): Promise<ImprovementJob[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM improvement_jobs WHERE repository_id = ? ORDER BY created_at DESC',
      )
      .all(repositoryId) as unknown as Row[];
    return rows.map((r) => this.fromRow(r));
  }

  async findByStatus(status: JobStatus): Promise<ImprovementJob[]> {
    const rows = this.db
      .prepare('SELECT * FROM improvement_jobs WHERE status = ? ORDER BY created_at')
      .all(status) as unknown as Row[];
    return rows.map((r) => this.fromRow(r));
  }

  async countActive(): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM improvement_jobs
          WHERE status IN ('pending','running')`,
      )
      .get() as unknown as { c: number };
    return row.c;
  }

  async findInFlightForFile(
    repositoryId: string,
    targetFilePath: string,
  ): Promise<ImprovementJob | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM improvement_jobs
          WHERE repository_id = ?
            AND target_file_path = ?
            AND status IN ('pending','running')
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(repositoryId, targetFilePath) as unknown | undefined;
    return row ? this.fromRow(row as Row) : null;
  }

  async appendLog(jobId: string, line: string): Promise<void> {
    this.db.prepare('INSERT INTO job_logs (job_id, line) VALUES (?, ?)').run(jobId, line);
  }

  async readLogs(jobId: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT line FROM job_logs WHERE job_id = ? ORDER BY id')
      .all(jobId) as unknown as { line: string }[];
    return rows.map((r) => r.line);
  }

  async delete(jobId: string): Promise<void> {
    // ON DELETE CASCADE on job_logs.job_id removes the log rows automatically.
    this.db.prepare('DELETE FROM improvement_jobs WHERE id = ?').run(jobId);
  }

  private fromRow(row: Row): ImprovementJob {
    return ImprovementJob.rehydrate({
      id: row.id,
      repositoryId: row.repository_id,
      targetFilePath: row.target_file_path,
      status: row.status as JobStatus,
      mode: (row.mode as ImprovementMode) ?? null,
      prUrl: row.pr_url,
      coverageBefore: row.coverage_before,
      coverageAfter: row.coverage_after,
      error: row.error,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    });
  }
}
