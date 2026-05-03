import { RepositoryId } from '../repository/RepositoryId';

/**
 * Domain service interface: schedules a repository-analysis worker call
 * onto the per-repository serial queue.
 *
 * Same per-repo serialization invariant as `JobScheduler` (improvement jobs):
 * within one repository, analysis and improvement work are serialized against
 * each other, because both contend for the same workdir and would race on
 * the cloned repo.
 *
 * The callback is intentionally `() => Promise<void>` rather than a typed job
 * aggregate — analysis isn't a persisted entity in the way ImprovementJob is;
 * its lifecycle lives on the Repository aggregate (analysisStatus field).
 */
export interface RepositoryAnalysisScheduler {
  /**
   * Enqueue an analysis run for `repositoryId`. The callback fires when the
   * per-repo queue reaches it. Returns immediately after enqueueing, NOT
   * after the work completes.
   */
  scheduleAnalysis(repositoryId: RepositoryId, run: () => Promise<void>): Promise<void>;
}
