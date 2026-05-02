import { AnalysisStatus, Repository } from '../repository/Repository';

export interface RepositoryRepository {
  save(repository: Repository): Promise<void>;
  findById(id: string): Promise<Repository | null>;
  findByOwnerAndName(owner: string, name: string): Promise<Repository | null>;
  list(): Promise<Repository[]>;
  /**
   * All repositories in the given analysis_status. Used by the boot-time
   * recovery path to re-enqueue `pending` analyses that survived a process
   * restart (their SQLite row persisted; their in-memory queue entry did not).
   */
  findByAnalysisStatus(status: AnalysisStatus): Promise<Repository[]>;
  /**
   * Delete a repository row. Foreign-key cascades remove its coverage
   * reports, file coverages, jobs, and job logs. The bot's GitHub fork
   * is left intact — it may have open PRs we don't want to surprise-delete.
   */
  delete(id: string): Promise<void>;
}
