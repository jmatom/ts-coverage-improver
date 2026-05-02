import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunImprovementJob } from '../../../src/application/usecases/RunImprovementJob';
import { ImprovementJob } from '../../../src/domain/job/ImprovementJob';
import { Repository } from '../../../src/domain/repository/Repository';
import { CoverageReport } from '../../../src/domain/coverage/CoverageReport';
import { FileCoverage } from '../../../src/domain/coverage/FileCoverage';
import { JobStatus } from '../../../src/domain/job/JobStatus';
import {
  GenerateTestInput,
  GenerateTestOutput,
} from '../../../src/domain/ports/AICliPort';

/**
 * Orchestration test: drives `RunImprovementJob` through its full state
 * machine + retry-with-feedback + append→sibling fallback by mocking every
 * port. The use case should depend on nothing concrete — these mocks prove it.
 */

// --- Mock ports --------------------------------------------------------------

class FakeJobs {
  rows = new Map<string, ImprovementJob>();
  logs: string[] = [];
  saveCount = 0;
  async save(j: ImprovementJob): Promise<void> {
    this.rows.set(j.id, j);
    this.saveCount++;
  }
  async findById(id: string): Promise<ImprovementJob | null> {
    return this.rows.get(id) ?? null;
  }
  async listByRepository(): Promise<ImprovementJob[]> {
    return [];
  }
  async findByStatus(_s: JobStatus): Promise<ImprovementJob[]> {
    return [];
  }
  async findInFlightForFile(): Promise<ImprovementJob | null> {
    return null;
  }
  async countActive(): Promise<number> {
    return 0;
  }
  async appendLog(_id: string, line: string): Promise<void> {
    this.logs.push(line);
  }
  async readLogs(): Promise<string[]> {
    return [...this.logs];
  }
  async delete(): Promise<void> {}
}

class FakeRepos {
  repo: Repository;
  saved = 0;
  constructor(repo: Repository) {
    this.repo = repo;
  }
  async save(_r: Repository): Promise<void> {
    this.saved++;
  }
  async findById(): Promise<Repository | null> {
    return this.repo;
  }
  async findByOwnerAndName(): Promise<Repository | null> {
    return this.repo;
  }
  async list(): Promise<Repository[]> {
    return [this.repo];
  }
  async delete(): Promise<void> {
    /* unused in orchestration tests */
  }
}

class FakeReports {
  constructor(private readonly latest: CoverageReport) {}
  async save(): Promise<void> {}
  async findLatestByRepository(): Promise<CoverageReport | null> {
    return this.latest;
  }
}

class FakeGitHub {
  forkCalls = 0;
  prCalls: string[] = [];
  prUrl = 'https://github.com/upstream/repo/pull/1';
  forkingAllowed = true;
  async whoami(): Promise<string> {
    return 'coverage-improver-bot';
  }
  async getRepositoryMeta() {
    return {
      defaultBranch: 'main',
      cloneUrl: '',
      isPrivate: false,
      forkingAllowed: this.forkingAllowed,
    };
  }
  async ensureFork(): Promise<{ owner: string; name: string }> {
    this.forkCalls++;
    return { owner: 'me', name: 'repo' };
  }
  async openPullRequest(input: { headBranch: string }): Promise<string> {
    this.prCalls.push(input.headBranch);
    return this.prUrl;
  }
}

class FakeGit {
  clones = 0;
  pushes = 0;
  resets = 0;
  constructor(private readonly workdir: string) {}
  async clone(): Promise<{ commitSha: string }> {
    this.clones++;
    return { commitSha: 'sha1' };
  }
  async commitAndPush(): Promise<void> {
    this.pushes++;
  }
  async resetWorkdir(_w: string): Promise<void> {
    this.resets++;
    // Wipe AI's leftover files between attempts so each runOneAttempt sees clean state.
    // (Real impl uses git reset; here we just clear our test fixture.)
  }
}

type ViolationKind = 'parse_error' | 'missing_block' | 'no_new_blocks';

class FakeValidator {
  parseOk = true;
  parseCalls = 0;
  appendOk = true;
  /** Kind of violation when appendOk is false. Default 'no_new_blocks' (behavioral). */
  appendViolationKind: ViolationKind = 'no_new_blocks';
  newOk = true;
  appendCalls = 0;
  newCalls = 0;
  parseCheck() {
    this.parseCalls++;
    return this.parseOk
      ? { ok: true as const, violations: [] }
      : {
          ok: false as const,
          violations: [{ kind: 'parse_error' as const, message: 'corrupt file' }],
        };
  }
  validateAppend() {
    this.appendCalls++;
    return this.appendOk
      ? { ok: true as const, violations: [] }
      : {
          ok: false as const,
          violations: [{ kind: this.appendViolationKind, message: `injected ${this.appendViolationKind}` }],
        };
  }
  validateNew() {
    this.newCalls++;
    return this.newOk
      ? { ok: true as const, violations: [] }
      : {
          ok: false as const,
          violations: [{ kind: 'no_new_blocks' as const, message: 'no tests' }],
        };
  }
}

class FakeCoverageRunner {
  postRunPct = 95;
  calls = 0;
  constructor(private readonly targetFile: string) {}
  async run() {
    this.calls++;
    return {
      framework: 'jest' as const,
      files: [
        FileCoverage.create({
          path: this.targetFile,
          linesPct: this.postRunPct,
          branchesPct: null,
          functionsPct: null,
          statementsPct: null,
          uncoveredLines: [],
        }),
      ],
      logs: '',
    };
  }
}

class FakeAi {
  id = 'fake';
  requiredEnv: readonly string[] = [];
  optionalEnv: readonly string[] = [];
  calls: GenerateTestInput[] = [];
  /** Per-call writers — pop one per call. */
  writers: Array<(input: GenerateTestInput) => GenerateTestOutput>;
  constructor(writers: Array<(input: GenerateTestInput) => GenerateTestOutput>) {
    this.writers = writers;
  }
  async generateTest(input: GenerateTestInput): Promise<GenerateTestOutput> {
    this.calls.push(input);
    const w = this.writers.shift();
    if (!w) throw new Error('AI ran out of scripted attempts');
    return w(input);
  }
}

// --- Fixtures ----------------------------------------------------------------

function makeFixture(opts: {
  targetFile: string;
  hasExistingTest: boolean;
}): { workdir: string; cleanup: () => void } {
  const workdir = mkdtempSync(join(tmpdir(), 'rij-'));
  mkdirSync(join(workdir, 'src'), { recursive: true });
  writeFileSync(
    join(workdir, opts.targetFile),
    `export function add(a: number, b: number) { return a + b; }\n`,
  );
  writeFileSync(
    join(workdir, 'package.json'),
    JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
  );
  if (opts.hasExistingTest) {
    const stem = opts.targetFile.replace(/\.ts$/, '');
    writeFileSync(
      join(workdir, `${stem}.test.ts`),
      `describe('add', () => { it('adds', () => { expect(true).toBe(true); }); });\n`,
    );
  }
  return {
    workdir,
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

function makeJob(repoId: string, file: string): ImprovementJob {
  return ImprovementJob.create({ repositoryId: repoId, targetFilePath: file });
}

function makeReport(repoId: string, file: string, linesPct: number): CoverageReport {
  return CoverageReport.create({
    repositoryId: repoId,
    commitSha: 'sha',
    files: [
      FileCoverage.create({
        path: file,
        linesPct,
        branchesPct: null,
        functionsPct: null,
        statementsPct: null,
        uncoveredLines: [3, 4, 5],
      }),
    ],
  });
}

// --- Tests -------------------------------------------------------------------

describe('RunImprovementJob (orchestration)', () => {
  let cleanup: () => void = () => {};
  afterEach(() => cleanup());

  it('happy path: append-mode, AST passes, coverage improves → opens PR + succeeds', async () => {
    const targetFile = 'src/add.ts';
    const { workdir, cleanup: c } = makeFixture({
      targetFile,
      hasExistingTest: true,
    });
    cleanup = c;

    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const github = new FakeGitHub();
    const git = new FakeGit(workdir);
    const validator = new FakeValidator();
    const coverageRunner = new FakeCoverageRunner(targetFile);

    const ai = new FakeAi([
      (input) => {
        // Simulate AI appending to the existing test file
        const stem = input.sourceFilePath.replace(/\.ts$/, '');
        writeFileSync(
          join(workdir, `${stem}.test.ts`),
          `describe('add', () => {
  it('adds', () => { expect(true).toBe(true); });
  it('adds two numbers', () => { expect(1 + 1).toBe(2); });
});`,
        );
        return { writtenFiles: [`${stem}.test.ts`], logs: '' };
      },
    ]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github,
      git,
      ai,
      coverageRunner,
      validator,
      jobWorkdirRoot: workdir.replace(/\/[^/]+$/, ''),
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    // Force the workdir to be the one we built
    (useCase as unknown as { deps: { jobWorkdirRoot: string } }).deps.jobWorkdirRoot =
      workdir.replace(/\/job-[^/]+$/, '');
    // Override the join behavior by ensuring the produced workdir matches our fixture:
    // Easiest path — recompute the expected workdir from the test directly.
    // RunImprovementJob will compute join(jobWorkdirRoot, `job-${id}`) — so put the
    // jobWorkdirRoot above and rename our fixture dir accordingly.
    const realWorkdir = join(
      (useCase as unknown as { deps: { jobWorkdirRoot: string } }).deps.jobWorkdirRoot,
      `job-${job.id}`,
    );
    if (realWorkdir !== workdir) {
      // Move our fixture content into the path the use case will compute.
      mkdirSync(realWorkdir, { recursive: true });
      // Swap fixture: simply re-use the same content layout under realWorkdir
      // by re-creating the fixture there, then swap cleanup.
      writeFileSync(
        join(realWorkdir, 'package.json'),
        JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
      );
      mkdirSync(join(realWorkdir, 'src'), { recursive: true });
      writeFileSync(
        join(realWorkdir, targetFile),
        `export function add(a: number, b: number) { return a + b; }\n`,
      );
      writeFileSync(
        join(realWorkdir, `src/add.test.ts`),
        `describe('add', () => { it('adds', () => { expect(true).toBe(true); }); });\n`,
      );
      // Override AI writer to land output in realWorkdir
      ai.writers = [
        (input) => {
          const stem = input.sourceFilePath.replace(/\.ts$/, '');
          writeFileSync(
            join(realWorkdir, `${stem}.test.ts`),
            `describe('add', () => {
  it('adds', () => { expect(true).toBe(true); });
  it('adds two numbers', () => { expect(1 + 1).toBe(2); });
});`,
          );
          return { writtenFiles: [`${stem}.test.ts`], logs: '' };
        },
      ];
      cleanup = () => {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(realWorkdir, { recursive: true, force: true });
      };
    }

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.mode).toBe('append');
    expect(finished?.prUrl).toBe(github.prUrl);
    expect(finished?.coverageBefore).toBe(50);
    expect(finished?.coverageAfter).toBe(95);
    expect(github.forkCalls).toBe(1);
    expect(git.pushes).toBe(1);
    expect(validator.appendCalls).toBe(1);
    expect(ai.calls).toHaveLength(1);
  });

  it('falls back to sibling-mode after 2 STRUCTURAL append failures', async () => {
    const targetFile = 'src/add.ts';

    // Set up workdir matching what the use case will compute.
    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const root = mkdtempSync(join(tmpdir(), 'rij-root-'));
    const workdir = join(root, `job-${job.id}`);
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    writeFileSync(
      join(workdir, targetFile),
      `export function add(a: number, b: number) { return a + b; }\n`,
    );
    writeFileSync(
      join(workdir, 'src/add.test.ts'),
      `describe('add', () => { it('adds', () => {}); });\n`,
    );
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const github = new FakeGitHub();
    const git = new FakeGit(workdir);
    const validator = new FakeValidator();
    // Append attempts rejected with `missing_block` — this is the
    // STRUCTURAL kind, which triggers sibling fallback.
    validator.appendOk = false;
    validator.appendViolationKind = 'missing_block';
    const coverageRunner = new FakeCoverageRunner(targetFile);

    const writeAppendBad = (input: GenerateTestInput): GenerateTestOutput => {
      writeFileSync(
        join(workdir, 'src/add.test.ts'),
        `// AI rewrote the file badly\n`,
      );
      return { writtenFiles: ['src/add.test.ts'], logs: '' };
    };
    const writeSiblingGood = (input: GenerateTestInput): GenerateTestOutput => {
      writeFileSync(
        join(workdir, 'src/add.generated.test.ts'),
        `describe('add', () => { it('a', () => {}); it('b', () => {}); });`,
      );
      return { writtenFiles: ['src/add.generated.test.ts'], logs: '' };
    };
    const ai = new FakeAi([writeAppendBad, writeAppendBad, writeSiblingGood]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github,
      git,
      ai,
      coverageRunner,
      validator,
      jobWorkdirRoot: root,
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.mode).toBe('sibling');
    expect(validator.appendCalls).toBe(2); // both append attempts validated and rejected
    expect(validator.newCalls).toBe(1); // sibling attempt validated and accepted
    expect(ai.calls.length).toBe(3);
    // Retry feedback should be present on the second AI call
    expect(ai.calls[1].retryFeedback).toMatch(/AST validation failed/);
  });

  it('does NOT fall back to sibling on BEHAVIORAL append failure (saves a sandbox spawn)', async () => {
    const targetFile = 'src/add.ts';

    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const root = mkdtempSync(join(tmpdir(), 'rij-noFallback-'));
    const workdir = join(root, `job-${job.id}`);
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    writeFileSync(join(workdir, targetFile), 'export function add() { return 0; }\n');
    writeFileSync(
      join(workdir, 'src/add.test.ts'),
      `describe('add', () => { it('exists', () => {}); });\n`,
    );
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const validator = new FakeValidator();
    validator.appendOk = false;
    validator.appendViolationKind = 'no_new_blocks'; // BEHAVIORAL — sibling won't help

    const ai = new FakeAi([
      () => {
        writeFileSync(
          join(workdir, 'src/add.test.ts'),
          `describe('add', () => { it('exists', () => {}); });`,
        );
        return { writtenFiles: ['src/add.test.ts'], logs: '' };
      },
      () => {
        writeFileSync(
          join(workdir, 'src/add.test.ts'),
          `describe('add', () => { it('exists', () => {}); });`,
        );
        return { writtenFiles: ['src/add.test.ts'], logs: '' };
      },
    ]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github: new FakeGitHub(),
      git: new FakeGit(workdir),
      ai,
      coverageRunner: new FakeCoverageRunner(targetFile),
      validator,
      jobWorkdirRoot: root,
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/sibling fallback skipped/);
    // Only 2 AI calls — the orchestrator did NOT spawn a third for sibling mode.
    expect(ai.calls.length).toBe(2);
    expect(validator.newCalls).toBe(0);
  });

  it('FAST-FAIL: existing test file does not parse → no AI spawn, no test run', async () => {
    const targetFile = 'src/add.ts';

    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const root = mkdtempSync(join(tmpdir(), 'rij-broken-'));
    const workdir = join(root, `job-${job.id}`);
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    writeFileSync(join(workdir, targetFile), 'export function add() { return 0; }\n');
    writeFileSync(
      join(workdir, 'src/add.test.ts'),
      `describe('add', () => { it('a', () => { /* missing closing` , // syntactically broken
    );
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const validator = new FakeValidator();
    validator.parseOk = false;
    const coverageRunner = new FakeCoverageRunner(targetFile);
    const ai = new FakeAi([]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github: new FakeGitHub(),
      git: new FakeGit(workdir),
      ai,
      coverageRunner,
      validator,
      jobWorkdirRoot: root,
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/does not parse/);
    expect(validator.parseCalls).toBe(1);
    expect(ai.calls.length).toBe(0); // no expensive sandbox spawn
    expect(coverageRunner.calls).toBe(0); // no test run either
  });

  it('FAST-FAIL: target source file missing from clone → no AI spawn', async () => {
    const targetFile = 'src/missing.ts';

    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const root = mkdtempSync(join(tmpdir(), 'rij-missing-'));
    const workdir = join(root, `job-${job.id}`);
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    // intentionally NOT creating src/missing.ts
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const ai = new FakeAi([]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github: new FakeGitHub(),
      git: new FakeGit(workdir),
      ai,
      coverageRunner: new FakeCoverageRunner(targetFile),
      validator: new FakeValidator(),
      jobWorkdirRoot: root,
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/missing from clone/);
    expect(ai.calls.length).toBe(0);
  });

  it('fails honestly after exhausting all attempts', async () => {
    const targetFile = 'src/add.ts';

    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const root = mkdtempSync(join(tmpdir(), 'rij-fail-'));
    const workdir = join(root, `job-${job.id}`);
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    writeFileSync(join(workdir, targetFile), 'export function x() {}\n');
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const github = new FakeGitHub();
    const git = new FakeGit(workdir);
    const validator = new FakeValidator();
    validator.newOk = false; // sibling validations always fail

    const ai = new FakeAi([
      () => {
        writeFileSync(
          join(workdir, 'src/add.generated.test.ts'),
          'describe(\'x\', () => {});',
        );
        return { writtenFiles: ['src/add.generated.test.ts'], logs: '' };
      },
      () => {
        writeFileSync(
          join(workdir, 'src/add.generated.test.ts'),
          'describe(\'x\', () => {});',
        );
        return { writtenFiles: ['src/add.generated.test.ts'], logs: '' };
      },
    ]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github,
      git,
      ai,
      coverageRunner: new FakeCoverageRunner(targetFile),
      validator,
      jobWorkdirRoot: root,
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/All attempts exhausted/);
    expect(github.forkCalls).toBe(0);
    expect(git.pushes).toBe(0);
  });

  it('fails when coverage does not strictly increase (the "meaningful tests" gate)', async () => {
    const targetFile = 'src/add.ts';

    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const root = mkdtempSync(join(tmpdir(), 'rij-cov-'));
    const workdir = join(root, `job-${job.id}`);
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    writeFileSync(join(workdir, targetFile), 'export function x() {}\n');
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const validator = new FakeValidator(); // both validators pass
    const coverageRunner = new FakeCoverageRunner(targetFile);
    coverageRunner.postRunPct = 50; // unchanged from before — should fail the gate
    const ai = new FakeAi([
      () => {
        writeFileSync(
          join(workdir, 'src/add.generated.test.ts'),
          'describe(\'x\', () => { it(\'noop\', () => {}); });',
        );
        return { writtenFiles: ['src/add.generated.test.ts'], logs: '' };
      },
      () => {
        writeFileSync(
          join(workdir, 'src/add.generated.test.ts'),
          'describe(\'x\', () => { it(\'noop\', () => {}); });',
        );
        return { writtenFiles: ['src/add.generated.test.ts'], logs: '' };
      },
    ]);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github: new FakeGitHub(),
      git: new FakeGit(workdir),
      ai,
      coverageRunner,
      validator,
      jobWorkdirRoot: root,
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/Coverage did not improve|All attempts exhausted/);
  });

  it('FAST-FAIL: upstream disallows forking → no clone, no AI spawn', async () => {
    const targetFile = 'src/add.ts';
    const repo = Repository.create({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const reports = new FakeReports(makeReport(repo.id, targetFile, 50));
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, targetFile);
    await jobs.save(job);

    const github = new FakeGitHub();
    github.forkingAllowed = false; // upstream blocks forks

    const git = new FakeGit('');
    const ai = new FakeAi([]);
    const coverageRunner = new FakeCoverageRunner(targetFile);

    const useCase = new RunImprovementJob({
      jobs,
      repos,
      reports,
      github,
      git,
      ai,
      coverageRunner,
      validator: new FakeValidator(),
      jobWorkdirRoot: '/tmp/dummy',
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id);

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/disallows forking/);
    expect(git.clones).toBe(0); // never even cloned
    expect(ai.calls.length).toBe(0);
    expect(coverageRunner.calls).toBe(0);
  });

  it('rejects an already-terminal job (idempotent re-run)', async () => {
    const repo = Repository.create({ owner: 'o', name: 'r', defaultBranch: 'main' });
    const jobs = new FakeJobs();
    const job = makeJob(repo.id, 'src/x.ts');
    job.fail('old failure');
    await jobs.save(job);

    const useCase = new RunImprovementJob({
      jobs,
      repos: new FakeRepos(repo),
      reports: new FakeReports(makeReport(repo.id, 'src/x.ts', 50)),
      github: new FakeGitHub(),
      git: new FakeGit(''),
      ai: new FakeAi([]),
      coverageRunner: new FakeCoverageRunner('src/x.ts'),
      validator: new FakeValidator(),
      jobWorkdirRoot: '/tmp',
      githubToken: 'tok',
      resolveAiEnv: () => ({}),
    });

    await useCase.execute(job.id); // should be a no-op

    const finished = await jobs.findById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toBe('old failure'); // unchanged
  });
});
