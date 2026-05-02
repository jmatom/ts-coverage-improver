import { join } from 'node:path';
import { CoverageReport } from '@domain/coverage/CoverageReport';
import { Repository } from '@domain/repository/Repository';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { GitPort } from '@domain/ports/GitPort';
import { CoverageRunnerPort } from '@domain/ports/CoverageRunnerPort';
import { findExistingTestPath } from '../util/findExistingTestPath';

export interface AnalyzeRepositoryCoverageDeps {
  repos: RepositoryRepository;
  reports: CoverageReportRepository;
  git: GitPort;
  coverageRunner: CoverageRunnerPort;
  /** Where to clone repos for analysis. Each call gets a unique sub-dir. */
  jobWorkdirRoot: string;
  /** PAT for cloning private repos and authenticating. */
  githubToken?: string;
}

/**
 * Analyze a repository's coverage:
 *   1. Clone (using the repo's default branch).
 *   2. If `coverage/lcov.info` is committed, parse it directly.
 *   3. Otherwise, invoke `coverageRunner.run(...)` which detects framework
 *      and runs install+tests in the sandbox.
 *   4. Persist a CoverageReport keyed by commit SHA, mark repo analyzed.
 */
export class AnalyzeRepositoryCoverage {
  constructor(private readonly deps: AnalyzeRepositoryCoverageDeps) {}

  async execute(input: { repositoryId: string }): Promise<{ commitSha: string; fileCount: number }> {
    const repo = await this.deps.repos.findById(input.repositoryId);
    if (!repo) throw new Error(`Repository not found: ${input.repositoryId}`);

    const workdir = join(this.deps.jobWorkdirRoot, `analyze-${repo.id}`);
    const { commitSha } = await this.deps.git.clone({
      cloneUrl: repo.cloneUrl,
      branch: repo.defaultBranch,
      workdir,
      token: this.deps.githubToken,
    });

    // CoverageRunnerPort is the single source of coverage data — its
    // implementation may opt to reuse a committed coverage/lcov.info or
    // run install+tests in the sandbox. The application doesn't care.
    const result = await this.deps.coverageRunner.run({ workdir });

    // Enrich each FileCoverage with `hasExistingTest`. The lcov payload alone
    // can't tell us this; we probe the freshly-cloned workdir for sibling test
    // files using the same heuristics RunImprovementJob uses at job time. This
    // makes the dashboard able to differentiate "needs append" from "needs
    // sibling" without re-cloning.
    //
    // Probes run in parallel via Promise.all — each await goes through libuv's
    // threadpool, so N files complete in roughly the time of the slowest probe
    // rather than serial-O(N). Keeps the event loop free during analyze.
    const enrichedFiles = await Promise.all(
      result.files.map(async (f) =>
        f.withHasExistingTest((await findExistingTestPath(workdir, f.path)) !== null),
      ),
    );

    const report = CoverageReport.create({
      repositoryId: repo.id,
      commitSha,
      files: enrichedFiles,
    });
    await this.deps.reports.save(report);

    repo.markAnalyzed();
    await this.deps.repos.save(repo);

    return { commitSha, fileCount: result.files.length };
  }
}
