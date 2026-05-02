import { Logger } from '@nestjs/common';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { RepositoryAnalysisScheduler } from '@domain/services/RepositoryAnalysisScheduler';
import {
  AnalysisAlreadyInFlightError,
  RepositoryNotFoundError,
} from '@domain/errors/DomainError';
import { AnalyzeRepositoryCoverage } from './AnalyzeRepositoryCoverage';
import { RepositorySummaryDto } from '../dto/Dto';

/**
 * Request-side use case for analyze-coverage.
 *
 * Mirrors the request/run split used for improvement jobs
 * (RequestImprovementJob + RunImprovementJob). The HTTP controller calls
 * `execute()` here:
 *   1. Validates the repo exists.
 *   2. Transitions `analysisStatus` to `pending` (and persists).
 *   3. Enqueues a call to `analyze.execute()` on the per-repo queue.
 *   4. Returns the repo summary (with `analysisStatus = 'pending'`)
 *      immediately.
 *
 * The HTTP request DOES NOT wait for the actual clone/install/tests to
 * finish — that work happens later on the queue worker, which can take
 * minutes for a large repo. The dashboard polls the repository summary
 * to observe the status transitions (pending → running → idle/failed).
 *
 * The Logger is injected via Nest's default logger pattern at the
 * infrastructure layer; passing a no-op logger in tests is fine.
 */
export class RequestRepositoryAnalysis {
  private readonly logger = new Logger('RequestRepositoryAnalysis');

  constructor(
    private readonly repos: RepositoryRepository,
    private readonly scheduler: RepositoryAnalysisScheduler,
    private readonly analyze: AnalyzeRepositoryCoverage,
  ) {}

  async execute(input: { repositoryId: string }): Promise<RepositorySummaryDto> {
    const repo = await this.repos.findById(input.repositoryId);
    if (!repo) throw new RepositoryNotFoundError(input.repositoryId);

    // Idempotency: if an analysis is already pending or running for this
    // repo, refuse the duplicate with HTTP 409 instead of silently
    // enqueueing a second worker run. The dashboard's button is already
    // disabled when `analysisStatus` is in flight; this guard catches
    // direct API callers, tab races, and the small window between a click
    // and the 202 response arriving back at the browser.
    if (repo.isAnalyzing) {
      throw new AnalysisAlreadyInFlightError(repo.id, repo.analysisStatus);
    }

    repo.markAnalysisRequested();
    await this.repos.save(repo);

    // Enqueue the worker call. We do NOT await `scheduleAnalysis` resolving
    // *the work itself* — the scheduler resolves as soon as the work is
    // scheduled onto the chain. The worker call's actual completion is
    // observed via subsequent polls of the repository summary.
    await this.scheduler.scheduleAnalysis(repo.id, async () => {
      try {
        await this.analyze.execute({ repositoryId: repo.id });
      } catch (e) {
        // The analyze use case already marks the repo as failed on
        // exception. We just log here so a stack-trace is captured for
        // debugging; the user sees the friendly `analysisError` message
        // on the next poll.
        this.logger.error(
          `Analysis failed for ${repo.fullName}: ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
    });

    return {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      forkOwner: repo.forkOwner,
      lastAnalyzedAt: repo.lastAnalyzedAt?.toISOString() ?? null,
      overallLinesPct: null,
      fileCount: 0,
      analysisStatus: repo.analysisStatus,
      analysisError: repo.analysisError,
      analysisStartedAt: repo.analysisStartedAt?.toISOString() ?? null,
    };
  }
}
