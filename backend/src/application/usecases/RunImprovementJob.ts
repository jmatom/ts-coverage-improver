import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findExistingTestPath } from '../util/findExistingTestPath';
import { scrubAgentConfig } from '../util/scrubAgentConfig';
import { findSuspectedSecret } from '../util/secretGuard';
import { CoverageReport } from '@domain/coverage/CoverageReport';
import { ImprovementJob } from '@domain/job/ImprovementJob';
import { ImprovementMode } from '@domain/job/JobStatus';
import { siblingTestPath } from '@domain/job/testFileNaming';
import { JobRepository } from '@domain/ports/JobRepository';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { GitHubPort } from '@domain/ports/GitHubPort';
import { GitPort } from '@domain/ports/GitPort';
import { AICliPort, SupportedTestFramework } from '@domain/ports/AICliPort';
import { CoverageRunnerPort } from '@domain/ports/CoverageRunnerPort';
import { TestSuiteValidatorPort } from '@domain/ports/TestSuiteValidatorPort';
import { JobExecutor } from './JobExecutor';

export interface RunImprovementJobDeps {
  jobs: JobRepository;
  repos: RepositoryRepository;
  reports: CoverageReportRepository;
  github: GitHubPort;
  git: GitPort;
  ai: AICliPort;
  coverageRunner: CoverageRunnerPort;
  validator: TestSuiteValidatorPort;
  jobWorkdirRoot: string;
  githubToken: string;
  resolveAiEnv: (requiredEnv: readonly string[]) => Record<string, string>;
}

const MAX_ATTEMPTS_PER_MODE = 2;

/**
 * The Day-2 orchestrator. Spec-derived sequence:
 *
 *   1. Mark running, capture coverageBefore.
 *   2. Clone repo into workdir.
 *   3. Decide initial mode (append if test file present, else sibling).
 *   4. AI generate → AST validate → test run → coverage delta.
 *   5. On failure, retry with feedback (up to 2 attempts per mode).
 *   6. After exhausting append-mode attempts, fall back to sibling-mode.
 *   7. On success: ensure fork, push branch, open PR, persist results.
 *
 * Errors at any step short-circuit to `job.fail(reason)`. The queue catches
 * unhandled throws as a safety net (see InMemoryPerRepoQueue).
 *
 * Application-layer purity: this use case depends only on domain ports
 * (Git, GitHub, AI, CoverageRunner, TestSuiteValidator) and Node's built-in
 * fs/path. It contains no `simple-git` / `@octokit` / TS-compiler imports —
 * those concerns live behind ports.
 */
export class RunImprovementJob implements JobExecutor {
  constructor(private readonly deps: RunImprovementJobDeps) {}

  async execute(jobId: string): Promise<void> {
    const job = await this.deps.jobs.findById(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.isTerminal()) return;

    const log = (line: string) =>
      this.deps.jobs.appendLog(jobId, `[${new Date().toISOString()}] ${line}`);

    try {
      const repo = await this.deps.repos.findById(job.repositoryId);
      if (!repo) throw new Error(`Repository ${job.repositoryId} not found`);
      const latest = await this.deps.reports.findLatestByRepository(repo.id);
      if (!latest) throw new Error('No coverage report — analyze repo first');
      const fileCov = latest.fileFor(job.targetFilePath);
      if (!fileCov) throw new Error(`File ${job.targetFilePath} missing from latest report`);

      job.start(fileCov.linesPct);
      await this.deps.jobs.save(job);
      await log(`Started job for ${repo.fullName} :: ${job.targetFilePath}`);

      // Fast-fail: refresh upstream metadata BEFORE clone. Catches repos
      // deleted, made private, or with forking disabled since registration —
      // all conditions where clone would either fail with a confusing error
      // or succeed but be useless for our fork-and-PR flow.
      const upstreamMeta = await this.deps.github
        .getRepositoryMeta(repo.owner, repo.name)
        .catch((e: Error) => {
          throw new Error(
            `Cannot reach upstream ${repo.fullName}: ${e.message}. ` +
              `The repo may have been deleted, renamed, or made private.`,
          );
        });
      if (!upstreamMeta.forkingAllowed) {
        job.fail(
          `Upstream ${repo.fullName} disallows forking — fork-and-PR flow can't be used. ` +
            `Ask the repo owner to enable forks, or use direct-push (not implemented in v1).`,
        );
        await this.deps.jobs.save(job);
        return;
      }

      // Clone root: where the entire repo lives.
      const cloneRoot = join(this.deps.jobWorkdirRoot, `job-${job.id}`);
      await log(`Cloning ${repo.cloneUrl} into ${cloneRoot}`);
      await this.deps.git.clone({
        cloneUrl: repo.cloneUrl,
        branch: repo.defaultBranch,
        workdir: cloneRoot,
        token: this.deps.githubToken,
      });

      // Package root: the directory containing this package's package.json.
      // Empty subpath = repo root (the common case). All package-level work
      // (install, tests, AI run, file probes) targets this dir; git operations
      // (resetWorkdir, push) stay at cloneRoot.
      const workdir = repo.subpath ? join(cloneRoot, repo.subpath) : cloneRoot;

      // Fast-fail: if the source file the user asked to improve isn't in the
      // clone, the report is stale (file renamed/deleted upstream). Bail
      // before spending any sandbox time.
      if (!existsSync(join(workdir, job.targetFilePath))) {
        job.fail(
          `Target file '${job.targetFilePath}' missing from clone — possibly renamed or moved upstream. Re-analyze and try again.`,
        );
        await this.deps.jobs.save(job);
        return;
      }

      const detectionInfo = readPackageInfo(workdir);
      const framework = detectFrameworkFromDeps(detectionInfo.allDeps);
      await log(`Detected framework: ${framework}`);

      const existingTestPath = await findExistingTestPath(workdir, job.targetFilePath);
      const styleExample = pickStyleExample(workdir, job.targetFilePath, existingTestPath);

      // Fast-fail: parse the existing test file BEFORE spawning a sandbox.
      // If it doesn't parse, the repo itself is broken and no AI work will
      // help. Failing here saves an expensive container roundtrip + an AI call.
      let beforeContent: string | null = null;
      if (existingTestPath) {
        beforeContent = readFileSync(join(workdir, existingTestPath), 'utf8');
        const parseRes = this.deps.validator.parseCheck(existingTestPath, beforeContent);
        if (!parseRes.ok) {
          job.fail(
            `Existing test file '${existingTestPath}' does not parse: ${parseRes.violations[0].message}. Fix the repo and re-analyze.`,
          );
          await this.deps.jobs.save(job);
          return;
        }
      }

      const initialMode: ImprovementMode = existingTestPath ? 'append' : 'sibling';
      await log(
        existingTestPath
          ? `Existing test file: ${existingTestPath} → starting in append mode`
          : 'No existing test file → starting in sibling mode',
      );

      const aiEnv = this.deps.resolveAiEnv(this.deps.ai.requiredEnv);

      // Build the attempt schedule. Sibling fallback runs only when:
      //  - sibling was the initial mode (no existing test file), or
      //  - all append attempts failed STRUCTURALLY (parse_error or
      //    missing_block — the merge dimension is what failed; a fresh
      //    file sidesteps that).
      // Behavioral failures (no_new_blocks, tests fail, coverage didn't
      // move) recur in sibling mode, so we don't waste another sandbox
      // spawn on them.
      let lastFailure = 'no attempts ran';
      let lastKind: FailureKind = 'behavioral' as FailureKind;
      let lastModeRun: ImprovementMode = initialMode;
      const success = await (async (): Promise<SuccessfulAttempt | null> => {
        const tryMode = async (mode: ImprovementMode): Promise<SuccessfulAttempt | null> => {
          lastModeRun = mode;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODE; attempt++) {
            await log(`Attempt ${attempt} (${mode}-mode)`);
            // git operates on the whole repo (subtree resets too), so reset
            // from cloneRoot — workdir might be a subpath of it for monorepos.
            await this.deps.git.resetWorkdir(cloneRoot);
            const result = await this.runOneAttempt({
              workdir,
              subpath: repo.subpath,
              job,
              latest,
              existingTestPath: mode === 'append' ? existingTestPath : null,
              hadExistingTestAtStart: existingTestPath !== null,
              beforeContent: mode === 'append' ? beforeContent : null,
              mode,
              framework,
              styleExample,
              aiEnv,
              retryFeedback: lastFailure === 'no attempts ran' ? undefined : lastFailure,
              log,
            });
            if (result.ok) return result;
            lastFailure = result.feedback;
            lastKind = result.kind;
            await log(`Attempt failed (${result.kind}): ${result.feedback}`);
            // Security failures halt immediately: do not burn more AI calls
            // on a probable prompt-injection attack, and don't fall back to
            // sibling mode (the planted attack surface persists across modes).
            if (result.kind === 'security') return null;
          }
          return null;
        };

        if (initialMode === 'append') {
          const won = await tryMode('append');
          if (won) return won;
          // Append exhausted. Only fall back to sibling on structural failures
          // (security and behavioral failures are not fixed by sibling mode).
          if (lastKind !== 'structural') return null;
        }
        return await tryMode('sibling');
      })();

      if (!success) {
        const skippedFallback =
          initialMode === 'append' && lastModeRun === 'append' && lastKind === 'behavioral'
            ? ' (sibling fallback skipped — last failure was behavioral, fresh file would not help)'
            : '';
        job.fail(`All attempts exhausted; last error: ${lastFailure}${skippedFallback}`);
        await this.deps.jobs.save(job);
        return;
      }

      const fork = await this.ensureForkOnce(repo);
      const branch = `coverage-improve/${slugFile(job.targetFilePath)}-${job.id.slice(0, 8)}`;
      const remoteUrl = `https://x-access-token:${this.deps.githubToken}@github.com/${fork.owner}/${fork.name}.git`;
      const message = `test: improve coverage for ${job.targetFilePath} (${success.coverageBefore.toFixed(0)}% → ${success.coverageAfter.toFixed(0)}%)`;
      await log(`Pushing branch ${branch} to fork ${fork.owner}/${fork.name}`);
      // git push from the repo root (cloneRoot). `success.writtenFiles` came
      // from the AI's view (paths relative to the package root), so prefix
      // them with the repo's subpath so commitAndPush can resolve them
      // relative to cloneRoot. Empty subpath = no prefix needed.
      const filesToAdd = repo.subpath
        ? success.writtenFiles.map((f) => `${repo.subpath}/${f}`)
        : success.writtenFiles;
      await this.deps.git.commitAndPush({
        workdir: cloneRoot,
        branch,
        filesToAdd,
        message,
        remoteUrl,
      });
      const prUrl = await this.deps.github.openPullRequest({
        upstream: { owner: repo.owner, name: repo.name },
        fork,
        headBranch: branch,
        baseBranch: repo.defaultBranch,
        title: `Improve test coverage for ${job.targetFilePath}`,
        body: prBody({
          targetFile: job.targetFilePath,
          before: success.coverageBefore,
          after: success.coverageAfter,
          framework,
          mode: success.mode,
          writtenFiles: success.writtenFiles,
        }),
      });
      await log(`PR opened: ${prUrl}`);

      job.succeed({ prUrl, coverageAfter: success.coverageAfter, mode: success.mode });
      await this.deps.jobs.save(job);
    } catch (e) {
      const reason = (e as Error).message;
      const fresh = await this.deps.jobs.findById(jobId);
      if (fresh && !fresh.isTerminal()) {
        fresh.fail(reason);
        await this.deps.jobs.save(fresh);
      }
      await log(`FAILED: ${reason}`);
    }
  }

  /** One attempt = AI run + AST validate + tests + coverage delta. */
  private async runOneAttempt(params: {
    workdir: string;
    /**
     * Repo subpath (empty for single-package repos). Used to strip the
     * `<subpath>/` prefix from `aiOut.writtenFiles` — diffWrittenFiles
     * resolves git paths against the repo root, so for monorepos paths
     * come back with the subpath baked in.
     */
    subpath: string;
    job: ImprovementJob;
    latest: CoverageReport;
    existingTestPath: string | null;
    /**
     * Whether the orchestrator found ANY existing test file at job start
     * (independent of `existingTestPath` which is null for sibling-mode
     * attempts). Drives sibling naming: false → `<basename>.test.ts`
     * (idiomatic), true → `<basename>.generated.test.ts` (fallback).
     */
    hadExistingTestAtStart: boolean;
    /** Pre-AI snapshot of the existing test file (parse-checked at the top level). */
    beforeContent: string | null;
    mode: ImprovementMode;
    framework: SupportedTestFramework;
    styleExample: string | null;
    aiEnv: Record<string, string>;
    retryFeedback?: string;
    log: (line: string) => Promise<void>;
  }): Promise<AttemptResult> {
    const fileCov = params.latest.fileFor(params.job.targetFilePath)!;
    const before = fileCov.linesPct;

    const targetTestFile =
      params.mode === 'append' && params.existingTestPath
        ? params.existingTestPath
        : siblingTestPath(params.job.targetFilePath, params.hadExistingTestAtStart);

    // Pre-AI hardening: drop any agent-config files (CLAUDE.md, .cursor/, …)
    // a malicious target repo (or its postinstall) may have planted to inject
    // instructions into Claude Code. Logged but not failed: agent-config
    // scrubbing is defense in depth, not a hard requirement.
    const scrubbed = await scrubAgentConfig(params.workdir);
    if (scrubbed.length > 0) {
      await params.log(`[security] scrubbed agent-config paths before AI invoke: ${scrubbed.join(', ')}`);
    }

    const aiOut = await this.deps.ai.generateTest({
      workdir: params.workdir,
      sourceFilePath: params.job.targetFilePath,
      existingTestFilePath: params.mode === 'append' ? params.existingTestPath : null,
      targetTestFilePath: targetTestFile,
      uncoveredLines: fileCov.uncoveredLines,
      framework: params.framework,
      targetMode: params.mode,
      styleExample: params.styleExample,
      env: params.aiEnv,
      retryFeedback: params.retryFeedback,
    });

    if (aiOut.writtenFiles.length === 0) {
      return fail(`AI did not write any files`, 'behavioral');
    }

    // Normalize: strip a leading `<subpath>/` from each written path so all
    // paths are package-root-relative. ClaudeCodeAdapter's `diffWrittenFiles`
    // resolves git paths against the repo root (cloneRoot), so for monorepos
    // we get back e.g. 'backend/src/foo.test.ts' even though the AI sees
    // /workspace = packageRoot.
    const normalizedWritten = params.subpath
      ? aiOut.writtenFiles.map((f) =>
          f.startsWith(`${params.subpath}/`) ? f.slice(params.subpath.length + 1) : f,
        )
      : aiOut.writtenFiles;

    // Tolerate Claude's choice of .test.ts vs .spec.ts. The prompt names one
    // (`targetTestFile`); both conventions are valid Jest sibling files.
    // Resolve to whichever the AI actually wrote, and treat it as the target.
    const altTarget = swapTestSpecExtension(targetTestFile);
    const candidateTargets = altTarget ? [targetTestFile, altTarget] : [targetTestFile];
    const matchedTarget = candidateTargets.find(
      (cand) =>
        normalizedWritten.includes(cand) && existsSync(join(params.workdir, cand)),
    );
    if (!matchedTarget) {
      return fail(
        `Expected test file at ${targetTestFile} but it was not created. ` +
          `Files written (normalized): ${normalizedWritten.join(', ')}`,
        'behavioral',
      );
    }

    // Subsequent code uses targetTestFile. Reassign to whichever variant
    // the AI actually wrote, so validation + commit see the real file.
    const resolvedTarget = matchedTarget;
    const targetAbs = join(params.workdir, resolvedTarget);
    const afterContent = readFileSync(targetAbs, 'utf8');

    // Post-AI safety net: scan logs and every written file for
    // secret-shaped strings (`sk-ant-…`, `ghp_…`, etc.). If found, refuse
    // to proceed — don't run validation, don't push the branch, don't
    // retry. Most likely an attempted prompt injection from the target
    // repo got partially through. See docs/security.md for the threat
    // model and the limits of this guard.
    const logHit = findSuspectedSecret(aiOut.logs);
    if (logHit) {
      return fail(
        `[security] suspected secret leak in AI logs (${logHit.name}, prefix '${logHit.prefix}…'); halting job to avoid pushing it upstream.`,
        'security',
      );
    }
    for (const rel of normalizedWritten) {
      const abs = join(params.workdir, rel);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf8');
      const fileHit = findSuspectedSecret(content);
      if (fileHit) {
        return fail(
          `[security] suspected secret leak in ${rel} (${fileHit.name}, prefix '${fileHit.prefix}…'); halting job to avoid pushing it upstream.`,
          'security',
        );
      }
    }
    const validation =
      params.mode === 'append' && params.beforeContent !== null
        ? this.deps.validator.validateAppend(resolvedTarget, params.beforeContent, afterContent)
        : this.deps.validator.validateNew(resolvedTarget, afterContent);
    if (!validation.ok) {
      // parse_error / missing_block are file-merge issues that a sibling
      // file would sidestep — mark structural so the orchestrator may retry
      // in sibling mode. no_new_blocks means the AI didn't add tests, which
      // recurs in sibling mode — mark behavioral.
      const isStructural = validation.violations.some(
        (v) => v.kind === 'parse_error' || v.kind === 'missing_block',
      );
      return fail(
        `AST validation failed: ${validation.violations.map((v) => v.message).join('; ')}`,
        isStructural ? 'structural' : 'behavioral',
      );
    }
    await params.log(`AST validation passed`);

    let result;
    try {
      result = await this.deps.coverageRunner.run({ workdir: params.workdir });
    } catch (e) {
      return fail(`Test run failed: ${(e as Error).message}`, 'behavioral');
    }
    const newFileCov = result.files.find((f) => f.path === params.job.targetFilePath);
    if (!newFileCov) {
      return fail(
        `Target file ${params.job.targetFilePath} not present in post-run coverage report`,
        'behavioral',
      );
    }
    if (newFileCov.linesPct <= before) {
      return fail(
        `Coverage did not improve: before=${before}%, after=${newFileCov.linesPct}%`,
        'behavioral',
      );
    }
    await params.log(
      `Coverage delta: ${before.toFixed(2)}% → ${newFileCov.linesPct.toFixed(2)}%`,
    );

    return {
      ok: true,
      mode: params.mode,
      // Return the normalized (subpath-stripped) paths so the caller can
      // re-add the subpath cleanly when committing from cloneRoot.
      writtenFiles: normalizedWritten,
      coverageBefore: before,
      coverageAfter: newFileCov.linesPct,
    };

    function fail(msg: string, kind: FailureKind): AttemptResult {
      return { ok: false, feedback: msg, kind };
    }
  }

  /** Idempotent: caches the fork on the Repository aggregate. */
  private async ensureForkOnce(repo: {
    id: string;
    owner: string;
    name: string;
    forkOwner: string | null;
  }): Promise<{ owner: string; name: string }> {
    if (repo.forkOwner) {
      return { owner: repo.forkOwner, name: repo.name };
    }
    const fork = await this.deps.github.ensureFork({ owner: repo.owner, name: repo.name });
    const aggregate = await this.deps.repos.findById(repo.id);
    if (aggregate) {
      aggregate.recordFork(fork.owner);
      await this.deps.repos.save(aggregate);
    }
    return fork;
  }
}

/**
 * - `structural`: the AI couldn't produce parseable / append-safe code.
 *   Worth retrying in sibling mode (a fresh file sidesteps append constraints).
 * - `behavioral`: the AI's code parsed and complied with append rules but
 *   tests failed or coverage didn't move. Sibling fallback won't fix this.
 * - `security`: the AI's output contained a suspected secret leak (e.g.
 *   matched a known PAT pattern). Halts retries and fallback immediately
 *   to avoid burning more AI calls on a probable prompt-injection attack.
 */
type FailureKind = 'structural' | 'behavioral' | 'security';
type SuccessfulAttempt = {
  ok: true;
  mode: ImprovementMode;
  writtenFiles: string[];
  coverageBefore: number;
  coverageAfter: number;
};
type AttemptResult =
  | SuccessfulAttempt
  | { ok: false; feedback: string; kind: FailureKind };

function readPackageInfo(workdir: string): { allDeps: Record<string, string> } {
  const pkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { allDeps: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } };
}

function detectFrameworkFromDeps(deps: Record<string, string>): SupportedTestFramework {
  if ('vitest' in deps) return 'vitest';
  if ('jest' in deps) return 'jest';
  if ('mocha' in deps) return 'mocha';
  throw new Error('No supported test framework (jest/vitest/mocha) detected');
}

function pickStyleExample(
  workdir: string,
  sourcePath: string,
  existingTestPath: string | null,
): string | null {
  const seen = new Set([existingTestPath, sourcePath].filter(Boolean) as string[]);
  const roots = ['', 'src', 'test', 'tests', '__tests__'];
  for (const root of roots) {
    const dir = join(workdir, root);
    const found = walkForTest(dir, 0, seen);
    if (found) {
      try {
        const content = readFileSync(found, 'utf8');
        return content.length > 4000 ? content.slice(0, 4000) : content;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function walkForTest(dir: string, depth: number, skip: Set<string>): string | null {
  if (depth > 4) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') {
      continue;
    }
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const r = walkForTest(full, depth + 1, skip);
      if (r) return r;
    } else if (/\.(test|spec)\.(ts|tsx)$/.test(entry) && !skip.has(full)) {
      return full;
    }
  }
  return null;
}

function slugFile(p: string): string {
  return p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function prBody(input: {
  targetFile: string;
  before: number;
  after: number;
  framework: SupportedTestFramework;
  mode: ImprovementMode;
  writtenFiles: string[];
}): string {
  return [
    `Automated test coverage improvement.`,
    ``,
    `**Target file**: \`${input.targetFile}\``,
    `**Coverage**: ${input.before.toFixed(2)}% → **${input.after.toFixed(2)}%**`,
    `**Framework**: ${input.framework}`,
    `**Mode**: ${input.mode}`,
    `**Files modified**:`,
    ...input.writtenFiles.map((f) => `- \`${f}\``),
    ``,
    `Generated by [TS Coverage Improver](https://github.com/) — tests pass and coverage of the target file strictly increased relative to baseline.`,
  ].join('\n');
}

/**
 * Swap a `.test.<ext>` suffix to `.spec.<ext>` (or vice versa). Returns
 * `null` if the input doesn't end with either pattern. Used to tolerate
 * Claude's choice of convention when it ignores the prompt's exact name.
 */
function swapTestSpecExtension(path: string): string | null {
  const m = path.match(/^(.*)\.(test|spec)\.([cm]?[tj]sx?)$/);
  if (!m) return null;
  const swap = m[2] === 'test' ? 'spec' : 'test';
  return `${m[1]}.${swap}.${m[3]}`;
}
