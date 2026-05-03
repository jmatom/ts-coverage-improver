import { JobRepository } from '@domain/ports/JobRepository';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { JobScheduler } from '@domain/services/JobScheduler';
import { RepositoryAnalysisScheduler } from '@domain/services/RepositoryAnalysisScheduler';
import { Logger } from '@domain/ports/LoggerPort';
import { AnalyzeRepositoryCoverage } from './AnalyzeRepositoryCoverage';

export interface RecoverPendingWorkResult {
  recoveredJobs: number;
  recoveredAnalyses: number;
}

/**
 * Boot-time recovery: re-enqueue any work persisted as `pending` from a
 * previous process. Their in-memory promise-chain entries died with the
 * previous process; the SQLite rows stayed.
 *
 * Without this, `pending` rows would sit forever after a restart — the user
 * sees "Queued…" but no worker is listening. This is distinct from the
 * `running`-row reconciliation in SqliteConnection, which marks abandoned
 * mid-flight work as `failed` so the user knows to re-click. `pending` rows
 * never started running, so the right action is to actually run them.
 *
 * Called from `AppModule.onModuleInit` AFTER the GitHub + sandbox readiness
 * checks pass. If those checks fail, recovering work would be pointless.
 *
 * Idempotent if invoked twice on the same boot (the second call would find
 * the rows already moved to `running`, so nothing to recover) — but in
 * practice it's only called once per process lifetime.
 */
export class RecoverPendingWork {
  constructor(
    private readonly jobs: JobRepository,
    private readonly repos: RepositoryRepository,
    private readonly scheduler: JobScheduler,
    private readonly analysisScheduler: RepositoryAnalysisScheduler,
    private readonly analyze: AnalyzeRepositoryCoverage,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<RecoverPendingWorkResult> {
    const result: RecoverPendingWorkResult = { recoveredJobs: 0, recoveredAnalyses: 0 };

    // Improvement jobs. Re-enqueue directly via the scheduler — bypasses
    // RequestImprovementJob's admission control (queue-depth cap, idempotency
    // guard) because these jobs were already admitted before the restart.
    const pendingJobs = await this.jobs.findByStatus('pending');
    for (const job of pendingJobs) {
      await this.scheduler.enqueue(job);
    }
    result.recoveredJobs = pendingJobs.length;
    if (pendingJobs.length > 0) {
      this.logger.log(`Recovered ${pendingJobs.length} pending improvement job(s)`);
    }

    // Repository analyses. Mirror the callback shape RequestRepositoryAnalysis
    // uses for the normal flow — the analyze use case marks the repo as
    // running/idle/failed itself, so we only need to swallow exceptions to
    // keep the queue chain alive.
    const pendingRepos = await this.repos.findByAnalysisStatus('pending');
    for (const repo of pendingRepos) {
      await this.analysisScheduler.scheduleAnalysis(repo.id, async () => {
        try {
          await this.analyze.execute({ repositoryId: repo.id });
        } catch (e) {
          this.logger.error(
            `Recovered analysis failed for ${repo.fullName}: ${(e as Error).message}`,
            (e as Error).stack,
          );
        }
      });
    }
    result.recoveredAnalyses = pendingRepos.length;
    if (pendingRepos.length > 0) {
      this.logger.log(`Recovered ${pendingRepos.length} pending analysis(es)`);
    }

    return result;
  }
}
