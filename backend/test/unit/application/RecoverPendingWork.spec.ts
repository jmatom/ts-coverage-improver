import { ImprovementJob } from '../../../src/domain/job/ImprovementJob';
import { JobStatus } from '../../../src/domain/job/JobStatus';
import { Repository, AnalysisStatus } from '../../../src/domain/repository/Repository';
import { RepositoryId } from '../../../src/domain/repository/RepositoryId';
import { JobRepository } from '../../../src/domain/ports/JobRepository';
import { RepositoryRepository } from '../../../src/domain/ports/RepositoryRepository';
import { JobScheduler } from '../../../src/domain/services/JobScheduler';
import { RepositoryAnalysisScheduler } from '../../../src/domain/services/RepositoryAnalysisScheduler';
import { Logger } from '../../../src/domain/ports/LoggerPort';
import { RecoverPendingWork } from '../../../src/application/usecases/RecoverPendingWork';
import { AnalyzeRepositoryCoverage } from '../../../src/application/usecases/AnalyzeRepositoryCoverage';

const noopLogger: Logger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

class FakeJobs implements JobRepository {
  pending: ImprovementJob[] = [];
  async save(): Promise<void> {}
  async findById(): Promise<ImprovementJob | null> {
    return null;
  }
  async listByRepository(): Promise<ImprovementJob[]> {
    return [];
  }
  async findByStatus(s: JobStatus): Promise<ImprovementJob[]> {
    return s === 'pending' ? this.pending : [];
  }
  async findInFlightForFile(): Promise<ImprovementJob | null> {
    return null;
  }
  async countActive(): Promise<number> {
    return this.pending.length;
  }
  async appendLog(): Promise<void> {}
  async readLogs(): Promise<string[]> {
    return [];
  }
  async delete(): Promise<void> {}
}

class FakeRepos implements RepositoryRepository {
  pending: Repository[] = [];
  async save(): Promise<void> {}
  async findById(): Promise<Repository | null> {
    return null;
  }
  async findByOwnerAndName(): Promise<Repository | null> {
    return null;
  }
  async list(): Promise<Repository[]> {
    return this.pending;
  }
  async findByAnalysisStatus(s: AnalysisStatus): Promise<Repository[]> {
    return s === 'pending' ? this.pending : [];
  }
  async delete(): Promise<void> {}
}

class FakeJobScheduler implements JobScheduler {
  enqueued: ImprovementJob[] = [];
  async enqueue(job: ImprovementJob): Promise<void> {
    this.enqueued.push(job);
  }
}

class FakeAnalysisScheduler implements RepositoryAnalysisScheduler {
  scheduled: Array<{ repoId: RepositoryId; run: () => Promise<void> }> = [];
  async scheduleAnalysis(repoId: RepositoryId, run: () => Promise<void>): Promise<void> {
    this.scheduled.push({ repoId, run });
  }
}

class FakeAnalyze {
  executed: RepositoryId[] = [];
  result: Promise<unknown> = Promise.resolve({ commitSha: 'sha', fileCount: 0 });
  async execute(input: { repositoryId: RepositoryId }): Promise<{ commitSha: string; fileCount: number }> {
    this.executed.push(input.repositoryId);
    return (await this.result) as { commitSha: string; fileCount: number };
  }
}

describe('RecoverPendingWork', () => {
  it('returns zeros and does nothing when there is no pending work', async () => {
    const useCase = new RecoverPendingWork(
      new FakeJobs(),
      new FakeRepos(),
      new FakeJobScheduler(),
      new FakeAnalysisScheduler(),
      new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage,
      noopLogger,
    );
    expect(await useCase.execute()).toEqual({ recoveredJobs: 0, recoveredAnalyses: 0 });
  });

  it('re-enqueues all pending improvement jobs onto the scheduler', async () => {
    const r1 = RepositoryId.new();
    const r2 = RepositoryId.new();
    const jobs = new FakeJobs();
    jobs.pending = [
      ImprovementJob.create({ repositoryId: r1, targetFilePath: 'a.ts' }),
      ImprovementJob.create({ repositoryId: r1, targetFilePath: 'b.ts' }),
      ImprovementJob.create({ repositoryId: r2, targetFilePath: 'c.ts' }),
    ];
    const scheduler = new FakeJobScheduler();
    const useCase = new RecoverPendingWork(
      jobs,
      new FakeRepos(),
      scheduler,
      new FakeAnalysisScheduler(),
      new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage,
      noopLogger,
    );

    const result = await useCase.execute();
    expect(result.recoveredJobs).toBe(3);
    expect(scheduler.enqueued).toHaveLength(3);
    expect(scheduler.enqueued.map((j) => j.targetFilePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('re-schedules all pending analyses, fired callback runs analyze.execute', async () => {
    const repos = new FakeRepos();
    const a = Repository.create({ owner: 'o1', name: 'r1', defaultBranch: 'main' });
    a.markAnalysisRequested();
    const b = Repository.create({ owner: 'o2', name: 'r2', defaultBranch: 'main' });
    b.markAnalysisRequested();
    repos.pending = [a, b];

    const analysisScheduler = new FakeAnalysisScheduler();
    const fakeAnalyze = new FakeAnalyze();
    const useCase = new RecoverPendingWork(
      new FakeJobs(),
      repos,
      new FakeJobScheduler(),
      analysisScheduler,
      fakeAnalyze as unknown as AnalyzeRepositoryCoverage,
      noopLogger,
    );

    const result = await useCase.execute();
    expect(result.recoveredAnalyses).toBe(2);
    expect(analysisScheduler.scheduled.map((s) => s.repoId)).toEqual([a.id, b.id]);
    // Workers haven't fired yet — only the schedule call ran.
    expect(fakeAnalyze.executed).toHaveLength(0);
    // Fire one callback manually; should call analyze.execute.
    await analysisScheduler.scheduled[0].run();
    expect(fakeAnalyze.executed).toEqual([a.id]);
  });

  it('a thrown analyze in the recovered callback is caught (chain stays alive)', async () => {
    const repos = new FakeRepos();
    const a = Repository.create({ owner: 'o', name: 'r', defaultBranch: 'main' });
    a.markAnalysisRequested();
    repos.pending = [a];

    const fakeAnalyze = new FakeAnalyze();
    fakeAnalyze.result = Promise.reject(new Error('install timed out'));
    const analysisScheduler = new FakeAnalysisScheduler();
    const useCase = new RecoverPendingWork(
      new FakeJobs(),
      repos,
      new FakeJobScheduler(),
      analysisScheduler,
      fakeAnalyze as unknown as AnalyzeRepositoryCoverage,
      noopLogger,
    );

    await useCase.execute();
    // Recovered callback must swallow exceptions, same as the normal flow's
    // RequestRepositoryAnalysis callback. Otherwise the queue chain would die.
    await expect(analysisScheduler.scheduled[0].run()).resolves.toBeUndefined();
  });

  it('handles a mix of pending jobs AND pending analyses in the same call', async () => {
    const jobs = new FakeJobs();
    jobs.pending = [ImprovementJob.create({ repositoryId: RepositoryId.new(), targetFilePath: 'a.ts' })];
    const repos = new FakeRepos();
    const a = Repository.create({ owner: 'o', name: 'r', defaultBranch: 'main' });
    a.markAnalysisRequested();
    repos.pending = [a];

    const jobSched = new FakeJobScheduler();
    const analysisSched = new FakeAnalysisScheduler();
    const useCase = new RecoverPendingWork(
      jobs,
      repos,
      jobSched,
      analysisSched,
      new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage,
      noopLogger,
    );

    const result = await useCase.execute();
    expect(result).toEqual({ recoveredJobs: 1, recoveredAnalyses: 1 });
    expect(jobSched.enqueued).toHaveLength(1);
    expect(analysisSched.scheduled).toHaveLength(1);
  });
});
