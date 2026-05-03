import { Logger } from '@nestjs/common';
import { join } from 'node:path';
import { CoverageReport } from '@domain/coverage/CoverageReport';
import { Repository } from '@domain/repository/Repository';
import { RepositoryId } from '@domain/repository/RepositoryId';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { GitPort } from '@domain/ports/GitPort';
import { CoverageRunnerPort } from '@domain/ports/CoverageRunnerPort';
import { SiblingTestPathFinderPort } from '@domain/ports/SiblingTestPathFinderPort';

export interface AnalyzeRepositoryCoverageDeps {
  repos: RepositoryRepository;
  reports: CoverageReportRepository;
  git: GitPort;
  coverageRunner: CoverageRunnerPort;
  siblingTestPathFinder: SiblingTestPathFinderPort;
  /** Where to clone repos for analysis. Each call gets a unique sub-dir. */
  jobWorkdirRoot: string;
  /** PAT for cloning private repos and authenticating. */
  githubToken?: string;
}

/**
 * Worker-side use case: actually analyze a repository's coverage.
 *
 *   1. Transition repo `analysisStatus` to `running`.
 *   2. Clone (using the repo's default branch).
 *   3. If `coverage/lcov.info` is committed, parse it directly.
 *   4. Otherwise, invoke `coverageRunner.run(...)` which detects framework
 *      and runs install+tests in the sandbox.
 *   5. Persist a CoverageReport keyed by commit SHA.
 *   6. Transition repo to `idle` (and update lastAnalyzedAt) on success,
 *      or `failed` (with the error message) on any thrown exception.
 *
 * The request-side use case `RequestRepositoryAnalysis` is what the HTTP
 * controller calls — it transitions the repo to `pending`, enqueues a
 * call to this `execute()` method on the per-repo queue, and returns
 * immediately. `execute()` here runs on the queue worker, not the
 * request thread.
 *
 * This class is also safe to call directly (synchronously) from tests
 * that want to bypass the queue.
 */
export class AnalyzeRepositoryCoverage {
  private readonly logger = new Logger('AnalyzeRepositoryCoverage');
  constructor(private readonly deps: AnalyzeRepositoryCoverageDeps) {}

  async execute(input: { repositoryId: RepositoryId }): Promise<{ commitSha: string; fileCount: number }> {
    const repo = await this.deps.repos.findById(input.repositoryId);
    if (!repo) throw new Error(`Repository not found: ${input.repositoryId.value}`);

    // Transition pending → running. If the repo wasn't pending (e.g. a test
    // calls .execute directly without going through Request), this throws —
    // that's a programming error, fail loud.
    repo.markAnalysisRunning();
    await this.deps.repos.save(repo);

    try {
      const result = await this.runUnsafe(repo);
      repo.markAnalyzed();
      await this.deps.repos.save(repo);
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      repo.markAnalysisFailed(msg);
      await this.deps.repos.save(repo);
      throw e;
    }
  }

  private async runUnsafe(
    repo: Repository,
  ): Promise<{ commitSha: string; fileCount: number }> {
    // Clone root: where the entire repo lives on disk.
    const cloneRoot = join(this.deps.jobWorkdirRoot, `analyze-${repo.id.value}`);
    const { commitSha } = await this.deps.git.clone({
      cloneUrl: repo.cloneUrl,
      branch: repo.defaultBranch,
      workdir: cloneRoot,
      token: this.deps.githubToken,
    });

    // Package root: where the package's `package.json` actually lives.
    // Empty subpath = repo root (the common case). All package-level
    // operations (install, tests, file probes) operate against this dir;
    // git operations stay at cloneRoot.
    const packageRoot = repo.subpath ? join(cloneRoot, repo.subpath) : cloneRoot;

    // CoverageRunnerPort is the single source of coverage data — its
    // implementation may opt to reuse a committed coverage/lcov.info or
    // run install+tests in the sandbox. The application doesn't care.
    const result = await this.deps.coverageRunner.run({ workdir: packageRoot });
    // Surface the runner's progress lines (framework, Node version, install /
    // test exit + duration) on the backend's stdout. Analyses don't have a
    // per-row log channel today; this at least makes the decisions visible
    // via `docker compose logs backend`.
    for (const line of result.logs.split('\n').filter((l) => l.trim() !== '')) {
      this.logger.log(`[${repo.fullName}] ${line}`);
    }

    // Enrich each FileCoverage with `hasExistingTest`. The lcov payload alone
    // can't tell us this; we probe the freshly-cloned package root for sibling
    // test files using the same heuristics RunImprovementJob uses at job time.
    // FileCoverage paths are relative to the package root (that's how Istanbul
    // emits them when run from there), so the probe path resolves naturally.
    //
    // Probes run in parallel via Promise.all — each await goes through libuv's
    // threadpool, so N files complete in roughly the time of the slowest probe
    // rather than serial-O(N). Keeps the event loop free during analyze.
    const enrichedFiles = await Promise.all(
      result.files.map(async (f) =>
        f.withHasExistingTest((await this.deps.siblingTestPathFinder.findExisting(packageRoot, f.path)) !== null),
      ),
    );

    const report = CoverageReport.create({
      repositoryId: repo.id,
      commitSha,
      files: enrichedFiles,
    });
    await this.deps.reports.save(report);

    return { commitSha, fileCount: result.files.length };
  }
}
