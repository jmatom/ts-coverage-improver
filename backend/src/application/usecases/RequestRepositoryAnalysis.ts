import { Repository } from '@domain/repository/Repository';
import { RepositoryId } from '@domain/repository/RepositoryId';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { RepositoryAnalysisScheduler } from '@domain/services/RepositoryAnalysisScheduler';
import { Logger } from '@domain/ports/LoggerPort';
import { RepositoryNotFoundError } from '@domain/errors/DomainError';
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
 * The Logger is consumed via the `Logger` port (domain/ports/LoggerPort);
 * the DI factory in `AppModule` injects a pre-scoped instance backed by
 * NestJS's built-in Logger. Tests pass a no-op fake.
 */
export class RequestRepositoryAnalysis {
  constructor(
    private readonly repos: RepositoryRepository,
    private readonly scheduler: RepositoryAnalysisScheduler,
    private readonly analyze: AnalyzeRepositoryCoverage,
    private readonly logger: Logger,
  ) {}

  async execute(input: { repositoryId: RepositoryId }): Promise<RepositorySummaryDto> {
    const repo = await this.repos.findById(input.repositoryId);
    if (!repo) throw new RepositoryNotFoundError(input.repositoryId.value);

    // Idempotency: if an analysis is already pending or running for this
    // repo, return the current state with HTTP 202 instead of throwing.
    // The user's intent ("ensure a fresh analysis runs") is already
    // satisfied by the in-flight one, so a duplicate request is a
    // no-op-success, not an error. The dashboard treats fresh and
    // duplicate responses identically (both 202 + repo summary), which
    // closes the rapid-double-click footgun cleanly. We DON'T re-enqueue
    // — the previous request already did that.
    if (repo.isAnalyzing) {
      this.logger.log(
        `Analysis already in flight for ${repo.fullName} (status=${repo.analysisStatus}) — returning current state`,
      );
      return this.toDto(repo);
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

    return this.toDto(repo);
  }

  private toDto(repo: Repository): RepositorySummaryDto {
    return {
      id: repo.id.value,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      forkOwner: repo.forkOwner,
      lastAnalyzedAt: repo.lastAnalyzedAt?.toISOString() ?? null,
      overallLinesPct: null,
      fileCount: 0,
      subpath: repo.subpath,
      analysisStatus: repo.analysisStatus,
      analysisError: repo.analysisError,
      analysisStartedAt: repo.analysisStartedAt?.toISOString() ?? null,
    };
  }
}
