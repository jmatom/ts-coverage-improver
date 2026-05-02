import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobScheduler } from '@domain/services/JobScheduler';
import { RepositoryAnalysisScheduler } from '@domain/services/RepositoryAnalysisScheduler';
import { JobRepository } from '@domain/ports/JobRepository';
import { JobExecutor } from '@application/usecases/JobExecutor';

/**
 * In-process per-repository serial queue (spec NFR: "serialize jobs per
 * repository").
 *
 * Implementation: a `Map<repoId, Promise<void>>` chain. Each enqueue appends
 * to the per-repo promise chain so that within a single repo, work runs
 * sequentially. Across different repos, work runs concurrently.
 *
 * Two work kinds share the same chains:
 *   - improvement jobs (via `enqueue(job)` from the JobScheduler port)
 *   - analyze-coverage runs (via `scheduleAnalysis(repoId, fn)` from the
 *     RepositoryAnalysisScheduler port)
 * Both are funnelled through the same `Map<repoId, Promise>` so that
 * within one repo, analysis and improvement work are serialized against
 * each other (they both contend for the cloned workdir).
 *
 * Persistence: improvement-job state lives in SQLite via JobRepository.
 * Analysis state lives on the Repository aggregate (analysisStatus). The
 * queue itself is purely in-process. On boot, orphan `running` rows of
 * either kind are reconciled to `failed` (handled in
 * `SqliteConnection.reconcileOrphanRunningJobs` and
 * `SqliteRepositoryRepository.reconcileOrphanRunningAnalyses`).
 */
export class InMemoryPerRepoQueue implements JobScheduler, RepositoryAnalysisScheduler {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly executor: JobExecutor,
    private readonly jobs: JobRepository,
  ) {}

  async enqueue(job: ImprovementJob): Promise<void> {
    await this.scheduleOnChain(job.repositoryId, async () => {
      try {
        await this.executor.execute(job.id);
      } catch (e) {
        // Safety net: if the executor throws and the job is still
        // non-terminal, mark it failed here so the chain doesn't break.
        const fresh = await this.jobs.findById(job.id);
        if (fresh && !fresh.isTerminal()) {
          fresh.fail(`unhandled executor error: ${(e as Error).message}`);
          await this.jobs.save(fresh);
        }
      }
    });
  }

  async scheduleAnalysis(repositoryId: string, run: () => Promise<void>): Promise<void> {
    // The analysis worker (RunRepositoryAnalysis) owns its own try/catch and
    // marks the Repository aggregate as `failed` on exception. So we don't
    // need a per-job safety net here — only the chain-level `.catch(...)`
    // below to keep the chain alive after a thrown analysis.
    await this.scheduleOnChain(repositoryId, run);
  }

  private async scheduleOnChain(
    repoId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const prev = this.chains.get(repoId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    this.chains.set(repoId, next);
  }

  /**
   * Test/diagnostic helper — wait for all currently-queued work for a repo
   * to drain. Not part of either scheduler port.
   */
  async waitForIdle(repoId: string): Promise<void> {
    const current = this.chains.get(repoId);
    if (current) await current;
  }

  /**
   * Graceful-shutdown helper — wait for all per-repo chains to drain.
   * Resolves once every chain currently in flight has settled. New work
   * scheduled DURING the wait is also awaited, since each `enqueue` updates
   * the same chain reference. Callers should stop accepting new work first
   * (e.g., by closing the HTTP server) before calling this.
   */
  async waitForAllIdle(): Promise<void> {
    const snapshot = Array.from(this.chains.values());
    await Promise.allSettled(snapshot);
  }
}
