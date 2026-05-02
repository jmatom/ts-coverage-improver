import { ImprovementJob } from '../job/ImprovementJob';
import { JobStatus } from '../job/JobStatus';

export interface JobRepository {
  save(job: ImprovementJob): Promise<void>;
  findById(id: string): Promise<ImprovementJob | null>;
  listByRepository(repositoryId: string): Promise<ImprovementJob[]>;
  findByStatus(status: JobStatus): Promise<ImprovementJob[]>;
  /**
   * Returns the most recent non-terminal job (status pending or running) for
   * a `(repositoryId, targetFilePath)` pair, or null if none. Used by the
   * idempotency guard in RequestImprovementJob — a second click on Improve
   * for the same file shouldn't enqueue a duplicate.
   */
  findInFlightForFile(
    repositoryId: string,
    targetFilePath: string,
  ): Promise<ImprovementJob | null>;
  appendLog(jobId: string, line: string): Promise<void>;
  readLogs(jobId: string): Promise<string[]>;
  /** Delete a job. ON DELETE CASCADE drops its job_logs in the same statement. */
  delete(jobId: string): Promise<void>;
  /**
   * Count of jobs in non-terminal status (pending OR running) across all
   * repositories. Used by the request-time backpressure guard in
   * RequestImprovementJob to reject enqueues when the system is saturated.
   */
  countActive(): Promise<number>;
}
