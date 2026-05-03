import { join } from 'node:path';
import { SqliteConnection } from '../../../src/infrastructure/persistence/SqliteConnection';
import { SqliteRepositoryRepository } from '../../../src/infrastructure/persistence/SqliteRepositoryRepository';
import { SqliteCoverageReportRepository } from '../../../src/infrastructure/persistence/SqliteCoverageReportRepository';
import { SqliteJobRepository } from '../../../src/infrastructure/persistence/SqliteJobRepository';
import { Repository } from '../../../src/domain/repository/Repository';
import { CoverageReport } from '../../../src/domain/coverage/CoverageReport';
import { FileCoverage } from '../../../src/domain/coverage/FileCoverage';
import { ImprovementJob } from '../../../src/domain/job/ImprovementJob';

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');

const fc = (path: string, linesPct: number, uncovered: number[] = []) =>
  FileCoverage.create({
    path,
    linesPct,
    branchesPct: null,
    functionsPct: null,
    uncoveredLines: uncovered,
  });

describe('SQLite persistence', () => {
  let conn: SqliteConnection;

  beforeEach(() => {
    conn = new SqliteConnection(':memory:');
    const applied = conn.applyMigrations(MIGRATIONS_DIR);
    expect(applied.length).toBeGreaterThan(0);
  });

  afterEach(() => conn.close());

  it('migrations are idempotent (no-op on second apply)', () => {
    const second = conn.applyMigrations(MIGRATIONS_DIR);
    expect(second).toEqual([]);
  });

  describe('SqliteRepositoryRepository', () => {
    it('round-trips a repository', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      r.recordFork('forker');
      r.markAnalyzed(new Date('2026-05-01T10:00:00Z'));
      await repo.save(r);

      const fetched = await repo.findById(r.id);
      expect(fetched?.owner).toBe('o');
      expect(fetched?.forkOwner).toBe('forker');
      expect(fetched?.lastAnalyzedAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');

      const byName = await repo.findByOwnerAndName('o', 'n');
      expect(byName?.id.value).toBe(r.id.value);

      const all = await repo.list();
      expect(all).toHaveLength(1);
    });

    it('round-trips subpath (monorepo support)', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({
        owner: 'o',
        name: 'n',
        defaultBranch: 'main',
        subpath: 'apps/web',
      });
      await repo.save(r);

      const fetched = await repo.findById(r.id);
      expect(fetched?.subpath).toBe('apps/web');
    });

    it('subpath defaults to empty for repos created without one', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repo.save(r);

      const fetched = await repo.findById(r.id);
      expect(fetched?.subpath).toBe('');
    });

    it('round-trips analysis-lifecycle fields (running with startedAt)', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      r.markAnalysisRequested();
      r.markAnalysisRunning(new Date('2026-05-01T11:30:00Z'));
      await repo.save(r);

      const fetched = await repo.findById(r.id);
      expect(fetched?.analysisStatus).toBe('running');
      expect(fetched?.analysisStartedAt?.toISOString()).toBe('2026-05-01T11:30:00.000Z');
      expect(fetched?.analysisError).toBeNull();
    });

    it('round-trips analysis-lifecycle fields (failed with error)', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      r.markAnalysisRequested();
      r.markAnalysisRunning();
      r.markAnalysisFailed('npm install timed out');
      await repo.save(r);

      const fetched = await repo.findById(r.id);
      expect(fetched?.analysisStatus).toBe('failed');
      expect(fetched?.analysisError).toBe('npm install timed out');
    });

    it('SqliteConnection.reconcileOrphanRunningAnalyses targets only running rows; pending and idle untouched', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const a = Repository.create({ owner: 'a', name: 'a', defaultBranch: 'main' });
      a.markAnalysisRequested();
      a.markAnalysisRunning();
      await repo.save(a);

      const b = Repository.create({ owner: 'b', name: 'b', defaultBranch: 'main' });
      b.markAnalysisRequested(); // pending — must NOT be reconciled, the
      // RecoverPendingWork use case re-enqueues it instead
      await repo.save(b);

      const c = Repository.create({ owner: 'c', name: 'c', defaultBranch: 'main' });
      // idle — should NOT be touched
      await repo.save(c);

      const result = conn.reconcileOrphanRunningAnalyses();
      // Crashed running row → auto-retried (under budget). Pending/idle untouched.
      expect(result).toEqual({ requeued: 1, failed: 0 });

      expect((await repo.findById(a.id))?.analysisStatus).toBe('pending');
      expect((await repo.findById(a.id))?.analysisAutoRetryCount).toBe(1);
      expect((await repo.findById(b.id))?.analysisStatus).toBe('pending');
      expect((await repo.findById(b.id))?.analysisError).toBeNull();
      expect((await repo.findById(c.id))?.analysisStatus).toBe('idle');
    });

    it('upserts on save with same id', async () => {
      const repo = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repo.save(r);
      r.recordFork('newfork');
      await repo.save(r);

      const fetched = await repo.findById(r.id);
      expect(fetched?.forkOwner).toBe('newfork');
    });
  });

  describe('SqliteCoverageReportRepository', () => {
    it('round-trips a coverage report with files', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const reports = new SqliteCoverageReportRepository(conn.db);

      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const report = CoverageReport.create({
        repositoryId: r.id,
        commitSha: 'sha1',
        files: [fc('a.ts', 50, [3, 4]), fc('b.ts', 100)],
        generatedAt: new Date('2026-05-01T11:00:00Z'),
      });
      await reports.save(report);

      const latest = await reports.findLatestByRepository(r.id);
      expect(latest?.files).toHaveLength(2);
      const a = latest!.fileFor('a.ts')!;
      expect(a.linesPct).toBe(50);
      expect(a.uncoveredLines).toEqual([3, 4]);
    });

    it('round-trips hasExistingTest (true/false/null)', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const reports = new SqliteCoverageReportRepository(conn.db);

      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const withTest = FileCoverage.create({
        path: 'with-test.ts',
        linesPct: 60,
        branchesPct: null,
        functionsPct: null,
        uncoveredLines: [],
        hasExistingTest: true,
      });
      const withoutTest = FileCoverage.create({
        path: 'without-test.ts',
        linesPct: 0,
        branchesPct: null,
        functionsPct: null,
        uncoveredLines: [],
        hasExistingTest: false,
      });
      // Default (omitted) → null. Mirrors lcov-only rows that haven't been
      // enriched by AnalyzeRepositoryCoverage.
      const unknown = fc('unknown.ts', 50);

      const report = CoverageReport.create({
        repositoryId: r.id,
        commitSha: 'sha-mix',
        files: [withTest, withoutTest, unknown],
      });
      await reports.save(report);

      const latest = await reports.findLatestByRepository(r.id);
      expect(latest!.fileFor('with-test.ts')!.hasExistingTest).toBe(true);
      expect(latest!.fileFor('without-test.ts')!.hasExistingTest).toBe(false);
      expect(latest!.fileFor('unknown.ts')!.hasExistingTest).toBeNull();
    });

    it('findLatestByRepository returns most recent by generated_at', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const reports = new SqliteCoverageReportRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const older = CoverageReport.create({
        repositoryId: r.id,
        commitSha: 'old',
        files: [fc('a.ts', 10)],
        generatedAt: new Date('2026-04-01T00:00:00Z'),
      });
      const newer = CoverageReport.create({
        repositoryId: r.id,
        commitSha: 'new',
        files: [fc('a.ts', 90)],
        generatedAt: new Date('2026-05-01T00:00:00Z'),
      });
      await reports.save(older);
      await reports.save(newer);

      const latest = await reports.findLatestByRepository(r.id);
      expect(latest?.commitSha).toBe('new');
      expect(latest?.fileFor('a.ts')?.linesPct).toBe(90);
    });

    it('delete cascades through the entire dependent chain', async () => {
      // Locks in: PRAGMA foreign_keys=ON + ON DELETE CASCADE on the four
      // child tables actually wipes everything when a repository is deleted.
      const repos = new SqliteRepositoryRepository(conn.db);
      const reports = new SqliteCoverageReportRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);

      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const report = CoverageReport.create({
        repositoryId: r.id,
        commitSha: 'sha',
        files: [fc('a.ts', 30, [3, 4]), fc('b.ts', 80)],
      });
      await reports.save(report);

      const job = ImprovementJob.create({
        repositoryId: r.id,
        targetFilePath: 'a.ts',
      });
      await jobs.save(job);
      await jobs.appendLog(job.id, 'log line 1');
      await jobs.appendLog(job.id, 'log line 2');

      // Sanity: rows exist before delete.
      const countBefore = (table: string) =>
        (
          conn.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as {
            n: number;
          }
        ).n;
      expect(countBefore('repositories')).toBe(1);
      expect(countBefore('coverage_reports')).toBe(1);
      expect(countBefore('file_coverages')).toBe(2);
      expect(countBefore('improvement_jobs')).toBe(1);
      expect(countBefore('job_logs')).toBe(2);

      await repos.delete(r.id);

      // After: every dependent row should be gone.
      expect(countBefore('repositories')).toBe(0);
      expect(countBefore('coverage_reports')).toBe(0);
      expect(countBefore('file_coverages')).toBe(0);
      expect(countBefore('improvement_jobs')).toBe(0);
      expect(countBefore('job_logs')).toBe(0);
    });
  });

  describe('SqliteJobRepository', () => {
    it('round-trips a job through its state machine', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);

      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const job = ImprovementJob.create({
        repositoryId: r.id,
        targetFilePath: 'src/foo.ts',
      });
      await jobs.save(job);

      job.start(40);
      await jobs.save(job);

      job.succeed({
        prUrl: 'https://gh/pr/1',
        coverageAfter: 90,
        mode: 'append',
      });
      await jobs.save(job);

      const fetched = await jobs.findById(job.id);
      expect(fetched?.status).toBe('succeeded');
      expect(fetched?.prUrl).toBe('https://gh/pr/1');
      expect(fetched?.coverageBefore).toBe(40);
      expect(fetched?.coverageAfter).toBe(90);
      expect(fetched?.mode).toBe('append');
    });

    it('logs append and read in order', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);
      const job = ImprovementJob.create({
        repositoryId: r.id,
        targetFilePath: 'x.ts',
      });
      await jobs.save(job);
      await jobs.appendLog(job.id, 'first');
      await jobs.appendLog(job.id, 'second');
      const lines = await jobs.readLogs(job.id);
      expect(lines).toEqual(['first', 'second']);
    });

    it('reconcileOrphanRunningJobs auto-retries a crashed running row (counter < 1)', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const j = ImprovementJob.create({ repositoryId: r.id, targetFilePath: 'x.ts' });
      j.start(10);
      await jobs.save(j);

      const result = conn.reconcileOrphanRunningJobs();
      expect(result).toEqual({ requeued: 1, failed: 0 });

      const fetched = await jobs.findById(j.id);
      expect(fetched?.status).toBe('pending');
      expect(fetched?.startedAt).toBeNull();
      expect(fetched?.autoRetryCount).toBe(1);
      // Row is now safe to be picked up again by RecoverPendingWork.
    });

    it('reconcileOrphanRunningJobs hard-fails a row whose retry budget is exhausted', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      // Simulate a row that has already been auto-retried once and crashed
      // again on the retry — autoRetryCount is at the cap.
      const j = ImprovementJob.create({ repositoryId: r.id, targetFilePath: 'x.ts' });
      j.start(10);
      await jobs.save(j);
      conn.db
        .prepare('UPDATE improvement_jobs SET auto_retry_count = 1 WHERE id = ?')
        .run(j.id.value);

      const result = conn.reconcileOrphanRunningJobs();
      expect(result).toEqual({ requeued: 0, failed: 1 });

      const fetched = await jobs.findById(j.id);
      expect(fetched?.status).toBe('failed');
      expect(fetched?.error).toMatch(/auto-retry budget exhausted/);
      expect(fetched?.completedAt).toBeInstanceOf(Date);
      expect(fetched?.autoRetryCount).toBe(1); // unchanged
    });

    it('reconcileOrphanRunningJobs leaves pending and terminal rows untouched', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);

      const pending = ImprovementJob.create({ repositoryId: r.id, targetFilePath: 'a.ts' });
      await jobs.save(pending);

      const succeeded = ImprovementJob.create({ repositoryId: r.id, targetFilePath: 'b.ts' });
      succeeded.start(10);
      succeeded.succeed({ prUrl: 'u', coverageAfter: 90, mode: 'append' });
      await jobs.save(succeeded);

      const result = conn.reconcileOrphanRunningJobs();
      expect(result).toEqual({ requeued: 0, failed: 0 });

      expect((await jobs.findById(pending.id))?.status).toBe('pending');
      expect((await jobs.findById(succeeded.id))?.status).toBe('succeeded');
    });

    it('reconcileOrphanRunningAnalyses auto-retries a crashed analysis (counter < 1)', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      r.markAnalysisRequested();
      r.markAnalysisRunning();
      await repos.save(r);

      const result = conn.reconcileOrphanRunningAnalyses();
      expect(result).toEqual({ requeued: 1, failed: 0 });

      const fetched = await repos.findById(r.id);
      expect(fetched?.analysisStatus).toBe('pending');
      expect(fetched?.analysisStartedAt).toBeNull();
      expect(fetched?.analysisError).toBeNull();
      expect(fetched?.analysisAutoRetryCount).toBe(1);
    });

    it('reconcileOrphanRunningAnalyses hard-fails when the budget is exhausted', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      r.markAnalysisRequested();
      r.markAnalysisRunning();
      await repos.save(r);
      conn.db
        .prepare('UPDATE repositories SET analysis_auto_retry_count = 1 WHERE id = ?')
        .run(r.id.value);

      const result = conn.reconcileOrphanRunningAnalyses();
      expect(result).toEqual({ requeued: 0, failed: 1 });

      const fetched = await repos.findById(r.id);
      expect(fetched?.analysisStatus).toBe('failed');
      expect(fetched?.analysisError).toMatch(/auto-retry budget exhausted/);
    });

    it('Repository.markAnalysisRequested resets analysisAutoRetryCount', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      r.markAnalysisRequested();
      r.markAnalysisRunning();
      await repos.save(r);
      conn.db
        .prepare('UPDATE repositories SET analysis_auto_retry_count = 1 WHERE id = ?')
        .run(r.id.value);

      const fetched = (await repos.findById(r.id))!;
      expect(fetched.analysisAutoRetryCount).toBe(1);

      // Simulate a manual re-request (e.g. user clicked "Re-analyze" after a
      // crash-recovered failure). The budget should reset to 0 so a future
      // crash can be auto-recovered again.
      fetched.markAnalyzed(); // back to idle first
      fetched.markAnalysisRequested();
      await repos.save(fetched);

      const after = await repos.findById(r.id);
      expect(after?.analysisAutoRetryCount).toBe(0);
    });

    it('listByRepository returns most recent first', async () => {
      const repos = new SqliteRepositoryRepository(conn.db);
      const jobs = new SqliteJobRepository(conn.db);
      const r = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      await repos.save(r);
      const j1 = ImprovementJob.create({ repositoryId: r.id, targetFilePath: 'a.ts' });
      await jobs.save(j1);
      // Tiny delay to ensure differentiable timestamps
      await new Promise((res) => setTimeout(res, 5));
      const j2 = ImprovementJob.create({ repositoryId: r.id, targetFilePath: 'b.ts' });
      await jobs.save(j2);
      const list = await jobs.listByRepository(r.id);
      expect(list[0].id.value).toBe(j2.id.value);
      expect(list[1].id.value).toBe(j1.id.value);
    });
  });
});
