import { DatabaseSync } from 'node:sqlite';
import { AnalysisStatus, Repository } from '@domain/repository/Repository';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';

interface Row {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  fork_owner: string | null;
  last_analyzed_at: string | null;
  analysis_status: string;
  analysis_error: string | null;
  analysis_started_at: string | null;
}

/**
 * SQLite-backed implementation of the RepositoryRepository port.
 *
 * Uses INSERT-or-UPDATE on save() so callers don't need to track new vs
 * existing — the aggregate manages its own identity, the row mirrors it.
 */
export class SqliteRepositoryRepository implements RepositoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(repository: Repository): Promise<void> {
    const props = repository.toPlain();
    this.db
      .prepare(
        `INSERT INTO repositories (id, owner, name, default_branch, fork_owner, last_analyzed_at,
                                   analysis_status, analysis_error, analysis_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner,
           name = excluded.name,
           default_branch = excluded.default_branch,
           fork_owner = excluded.fork_owner,
           last_analyzed_at = excluded.last_analyzed_at,
           analysis_status = excluded.analysis_status,
           analysis_error = excluded.analysis_error,
           analysis_started_at = excluded.analysis_started_at`,
      )
      .run(
        props.id,
        props.owner,
        props.name,
        props.defaultBranch,
        props.forkOwner,
        props.lastAnalyzedAt ? props.lastAnalyzedAt.toISOString() : null,
        props.analysisStatus,
        props.analysisError,
        props.analysisStartedAt ? props.analysisStartedAt.toISOString() : null,
      );
  }

  async findById(id: string): Promise<Repository | null> {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as
      | unknown
      | undefined;
    return row ? this.fromRow(row as Row) : null;
  }

  async findByOwnerAndName(owner: string, name: string): Promise<Repository | null> {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE owner = ? AND name = ?')
      .get(owner, name) as unknown | undefined;
    return row ? this.fromRow(row as Row) : null;
  }

  async list(): Promise<Repository[]> {
    const rows = this.db
      .prepare('SELECT * FROM repositories ORDER BY owner, name')
      .all() as unknown as Row[];
    return rows.map((r) => this.fromRow(r));
  }

  async delete(id: string): Promise<void> {
    // Foreign-key cascades drop coverage_reports → file_coverages and
    // improvement_jobs → job_logs. PRAGMA foreign_keys=ON is set in
    // SqliteConnection, so this is a single statement.
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
  }

  private fromRow(row: Row): Repository {
    return Repository.rehydrate({
      id: row.id,
      owner: row.owner,
      name: row.name,
      defaultBranch: row.default_branch,
      forkOwner: row.fork_owner,
      lastAnalyzedAt: row.last_analyzed_at ? new Date(row.last_analyzed_at) : null,
      analysisStatus: row.analysis_status as AnalysisStatus,
      analysisError: row.analysis_error,
      analysisStartedAt: row.analysis_started_at ? new Date(row.analysis_started_at) : null,
    });
  }
}
