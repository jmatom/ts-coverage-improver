import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobScheduler } from '@domain/services/JobScheduler';
import { JobRepository } from '@domain/ports/JobRepository';
import { JobExecutor } from '@application/usecases/JobExecutor';

/**
 * In-process per-repository serial queue (spec NFR: "serialize jobs per repository").
 *
 * Implementation: a `Map<repoId, Promise<void>>` chain. Each enqueue appends
 * to the per-repo promise chain so that within a single repo, jobs run
 * sequentially. Across different repos, jobs run concurrently.
 *
 * Persistence: state lives in SQLite via JobRepository — the queue itself
 * is purely in-process. On boot, orphan `running` rows are reconciled to
 * `failed` (handled in SqliteConnection.reconcileOrphanRunningJobs); we do
 * not attempt to resume mid-job work, since most failures are non-idempotent
 * (PRs, fork creation).
 *
 * Error policy: the executor is expected to mark the job failed on its own
 * exception paths. As a safety net, if the executor throws and the job is
 * still non-terminal, we fail it here with the error message. This protects
 * the chain from breaking on unexpected throws.
 */
export class InMemoryPerRepoQueue implements JobScheduler {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly executor: JobExecutor,
    private readonly jobs: JobRepository,
  ) {}

  async enqueue(job: ImprovementJob): Promise<void> {
    const repoId = job.repositoryId;
    const prev = this.chains.get(repoId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.executor.execute(job.id);
        } catch (e) {
          const fresh = await this.jobs.findById(job.id);
          if (fresh && !fresh.isTerminal()) {
            fresh.fail(`unhandled executor error: ${(e as Error).message}`);
            await this.jobs.save(fresh);
          }
        }
      });
    this.chains.set(repoId, next);
  }

  /**
   * Test/diagnostic helper — wait for all currently-queued work for a repo
   * to drain. Not part of the JobScheduler port.
   */
  async waitForIdle(repoId: string): Promise<void> {
    const current = this.chains.get(repoId);
    if (current) await current;
  }
}
