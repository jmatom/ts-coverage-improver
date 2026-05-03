import { ImprovementJob } from '../job/ImprovementJob';
import { JobId } from '../job/JobId';
import { JobStatus } from '../job/JobStatus';
import { RepositoryId } from '../repository/RepositoryId';

export interface JobRepository {
  save(job: ImprovementJob): Promise<void>;
  findById(id: JobId): Promise<ImprovementJob | null>;
  listByRepository(repositoryId: RepositoryId): Promise<ImprovementJob[]>;
  findByStatus(status: JobStatus): Promise<ImprovementJob[]>;
  /**
   * Returns the most recent non-terminal job (status pending or running) for
   * a `(repositoryId, targetFilePath)` pair, or null if none. Used by the
   * idempotency guard in RequestImprovementJob — a second click on Improve
   * for the same file shouldn't enqueue a duplicate.
   */
  findInFlightForFile(
    repositoryId: RepositoryId,
    targetFilePath: string,
  ): Promise<ImprovementJob | null>;
  appendLog(jobId: JobId, line: string): Promise<void>;
  readLogs(jobId: JobId): Promise<string[]>;
  /** Delete a job. ON DELETE CASCADE drops its job_logs in the same statement. */
  delete(jobId: JobId): Promise<void>;
  /**
   * Count of jobs in non-terminal status (pending OR running) across all
   * repositories. Used by the request-time backpressure guard in
   * RequestImprovementJob to reject enqueues when the system is saturated.
   */
  countActive(): Promise<number>;
}
