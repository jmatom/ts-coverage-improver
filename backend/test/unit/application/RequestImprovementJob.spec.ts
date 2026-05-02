import { RequestImprovementJob } from '../../../src/application/usecases/RequestImprovementJob';
import { CoverageReport } from '../../../src/domain/coverage/CoverageReport';
import { FileCoverage } from '../../../src/domain/coverage/FileCoverage';
import { ImprovementJob } from '../../../src/domain/job/ImprovementJob';
import { JobRepository } from '../../../src/domain/ports/JobRepository';
import { CoverageReportRepository } from '../../../src/domain/ports/CoverageReportRepository';
import { JobScheduler } from '../../../src/domain/services/JobScheduler';
import { JobStatus } from '../../../src/domain/job/JobStatus';
import {
  FileAlreadyFullyCoveredError,
  FileNotInLatestReportError,
  JobAlreadyInFlightError,
  NoCoverageReportError,
} from '../../../src/domain/errors/DomainError';

const makeReport = (filePaths: string[]) =>
  CoverageReport.create({
    repositoryId: 'r1',
    commitSha: 'sha',
    files: filePaths.map((p) =>
      FileCoverage.create({
        path: p,
        linesPct: 50,
        branchesPct: null,
        functionsPct: null,
        statementsPct: null,
        uncoveredLines: [],
      }),
    ),
  });

class StubJobs implements JobRepository {
  saved: ImprovementJob[] = [];
  inFlight: ImprovementJob | null = null;
  active = 0;
  async save(j: ImprovementJob): Promise<void> {
    this.saved.push(j);
  }
  async findById(): Promise<ImprovementJob | null> {
    return null;
  }
  async listByRepository(): Promise<ImprovementJob[]> {
    return [];
  }
  async findByStatus(_s: JobStatus): Promise<ImprovementJob[]> {
    return [];
  }
  async findInFlightForFile(): Promise<ImprovementJob | null> {
    return this.inFlight;
  }
  async countActive(): Promise<number> {
    return this.active;
  }
  async appendLog(): Promise<void> {}
  async delete(): Promise<void> {}
  async readLogs(): Promise<string[]> {
    return [];
  }
}

class StubReports implements CoverageReportRepository {
  constructor(private readonly latest: CoverageReport | null) {}
  async save(): Promise<void> {}
  async findLatestByRepository(): Promise<CoverageReport | null> {
    return this.latest;
  }
}

class StubScheduler implements JobScheduler {
  enqueued: ImprovementJob[] = [];
  async enqueue(j: ImprovementJob): Promise<void> {
    this.enqueued.push(j);
  }
}

describe('RequestImprovementJob', () => {
  it('persists pending job and enqueues on the scheduler', async () => {
    const reports = new StubReports(makeReport(['src/foo.ts', 'src/bar.ts']));
    const jobs = new StubJobs();
    const scheduler = new StubScheduler();
    const useCase = new RequestImprovementJob(jobs, reports, scheduler);

    const dto = await useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' });

    expect(dto.status).toBe('pending');
    expect(dto.targetFilePath).toBe('src/foo.ts');
    expect(jobs.saved).toHaveLength(1);
    expect(jobs.saved[0].status).toBe('pending');
    expect(scheduler.enqueued).toHaveLength(1);
    expect(scheduler.enqueued[0].id).toBe(jobs.saved[0].id);
  });

  it('rejects when no coverage report exists yet', async () => {
    const reports = new StubReports(null);
    const useCase = new RequestImprovementJob(
      new StubJobs(),
      reports,
      new StubScheduler(),
    );
    await expect(
      useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' }),
    ).rejects.toBeInstanceOf(NoCoverageReportError);
  });

  it('rejects with FileNotInLatestReportError when target file is missing', async () => {
    const reports = new StubReports(makeReport(['src/foo.ts']));
    const useCase = new RequestImprovementJob(
      new StubJobs(),
      reports,
      new StubScheduler(),
    );
    await expect(
      useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/missing.ts' }),
    ).rejects.toBeInstanceOf(FileNotInLatestReportError);
  });

  it('rejects when target file is already at 100% (skip-already-covered fast-fail)', async () => {
    const fullyCoveredReport = CoverageReport.create({
      repositoryId: 'r1',
      commitSha: 'sha',
      files: [
        FileCoverage.create({
          path: 'src/foo.ts',
          linesPct: 100,
          branchesPct: null,
          functionsPct: null,
          statementsPct: null,
          uncoveredLines: [],
        }),
      ],
    });
    const useCase = new RequestImprovementJob(
      new StubJobs(),
      new StubReports(fullyCoveredReport),
      new StubScheduler(),
    );
    await expect(
      useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' }),
    ).rejects.toBeInstanceOf(FileAlreadyFullyCoveredError);
  });

  it('rejects with JobAlreadyInFlightError when an in-flight job exists for the same file', async () => {
    const reports = new StubReports(makeReport(['src/foo.ts']));
    const jobs = new StubJobs();
    // Pretend a previously-queued job is still pending for this file.
    const existing = ImprovementJob.create({
      repositoryId: 'r1',
      targetFilePath: 'src/foo.ts',
    });
    jobs.inFlight = existing;
    const scheduler = new StubScheduler();
    const useCase = new RequestImprovementJob(jobs, reports, scheduler);

    await expect(
      useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' }),
    ).rejects.toBeInstanceOf(JobAlreadyInFlightError);
    // Idempotency: nothing was persisted or enqueued by the rejected request.
    expect(jobs.saved).toHaveLength(0);
    expect(scheduler.enqueued).toHaveLength(0);
  });

  describe('queue-depth backpressure', () => {
    it('rejects with QueueDepthExceededError once the cap is hit', async () => {
      const reports = new StubReports(makeReport(['src/foo.ts']));
      const jobs = new StubJobs();
      jobs.active = 5;
      const scheduler = new StubScheduler();
      const useCase = new RequestImprovementJob(jobs, reports, scheduler, {
        maxQueueDepth: 5,
      });

      await expect(
        useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' }),
      ).rejects.toMatchObject({
        code: 'QUEUE_DEPTH_EXCEEDED',
      });
      expect(jobs.saved).toHaveLength(0);
      expect(scheduler.enqueued).toHaveLength(0);
    });

    it('admits when cap not yet reached', async () => {
      const reports = new StubReports(makeReport(['src/foo.ts']));
      const jobs = new StubJobs();
      jobs.active = 4;
      const scheduler = new StubScheduler();
      const useCase = new RequestImprovementJob(jobs, reports, scheduler, {
        maxQueueDepth: 5,
      });

      const dto = await useCase.execute({
        repositoryId: 'r1',
        targetFilePath: 'src/foo.ts',
      });
      expect(dto.status).toBe('pending');
      expect(jobs.saved).toHaveLength(1);
    });

    it('disabled by maxQueueDepth=0 (default)', async () => {
      const reports = new StubReports(makeReport(['src/foo.ts']));
      const jobs = new StubJobs();
      jobs.active = 9999;
      const useCase = new RequestImprovementJob(
        jobs,
        reports,
        new StubScheduler(),
        // omit options → cap defaults to 0 → no admission control
      );
      const dto = await useCase.execute({
        repositoryId: 'r1',
        targetFilePath: 'src/foo.ts',
      });
      expect(dto.status).toBe('pending');
    });

    it('idempotency takes precedence over backpressure', async () => {
      // If both an in-flight job AND queue saturation hold, surface the more
      // specific 409 (already in flight) rather than 503 — better UX.
      const reports = new StubReports(makeReport(['src/foo.ts']));
      const jobs = new StubJobs();
      jobs.active = 999;
      jobs.inFlight = ImprovementJob.create({
        repositoryId: 'r1',
        targetFilePath: 'src/foo.ts',
      });
      const useCase = new RequestImprovementJob(
        jobs,
        reports,
        new StubScheduler(),
        { maxQueueDepth: 5 },
      );
      await expect(
        useCase.execute({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' }),
      ).rejects.toBeInstanceOf(JobAlreadyInFlightError);
    });
  });
});
