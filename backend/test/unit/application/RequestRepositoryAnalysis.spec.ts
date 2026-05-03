import { Repository } from '../../../src/domain/repository/Repository';
import { RepositoryId } from '../../../src/domain/repository/RepositoryId';
import { RepositoryRepository } from '../../../src/domain/ports/RepositoryRepository';
import { RepositoryAnalysisScheduler } from '../../../src/domain/services/RepositoryAnalysisScheduler';
import {
  RepositoryNotFoundError,
} from '../../../src/domain/errors/DomainError';
import { RequestRepositoryAnalysis } from '../../../src/application/usecases/RequestRepositoryAnalysis';
import { AnalyzeRepositoryCoverage } from '../../../src/application/usecases/AnalyzeRepositoryCoverage';

class FakeRepos implements RepositoryRepository {
  saved: Repository[] = [];
  constructor(private readonly initial: Repository | null) {}
  async save(r: Repository): Promise<void> {
    this.saved.push(r);
  }
  async findById(): Promise<Repository | null> {
    return this.initial;
  }
  async findByOwnerAndName(): Promise<Repository | null> {
    return this.initial;
  }
  async list(): Promise<Repository[]> {
    return this.initial ? [this.initial] : [];
  }
  async findByAnalysisStatus(): Promise<Repository[]> {
    return this.initial ? [this.initial] : [];
  }
  async delete(): Promise<void> {}
}

class FakeScheduler implements RepositoryAnalysisScheduler {
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

describe('RequestRepositoryAnalysis', () => {
  it('marks the repo as pending, persists, enqueues, and returns 202-style DTO synchronously', async () => {
    const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const scheduler = new FakeScheduler();
    const analyze = new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage;
    const useCase = new RequestRepositoryAnalysis(repos, scheduler, analyze);

    const dto = await useCase.execute({ repositoryId: repo.id });

    // 1. Repo persisted in `pending` state — that's the user-visible result.
    expect(repos.saved).toHaveLength(1);
    expect(repos.saved[0].analysisStatus).toBe('pending');

    // 2. Worker call enqueued — but NOT yet executed.
    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0].repoId).toBe(repo.id);
    expect((analyze as unknown as FakeAnalyze).executed).toHaveLength(0);

    // 3. DTO reflects pending state for the dashboard to start polling.
    expect(dto.analysisStatus).toBe('pending');
    expect(dto.analysisError).toBeNull();
  });

  it('rejects unknown repository with a domain error', async () => {
    const repos = new FakeRepos(null);
    const scheduler = new FakeScheduler();
    const analyze = new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage;
    const useCase = new RequestRepositoryAnalysis(repos, scheduler, analyze);

    await expect(useCase.execute({ repositoryId: RepositoryId.new() })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    expect(scheduler.scheduled).toHaveLength(0);
  });

  it('the scheduler callback runs analyze.execute when fired', async () => {
    const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const scheduler = new FakeScheduler();
    const fake = new FakeAnalyze();
    const analyze = fake as unknown as AnalyzeRepositoryCoverage;
    const useCase = new RequestRepositoryAnalysis(repos, scheduler, analyze);

    await useCase.execute({ repositoryId: repo.id });

    // Manually fire the queued callback (the queue impl would do this).
    await scheduler.scheduled[0].run();
    expect(fake.executed).toEqual([repo.id]);
  });

  it('a thrown analyze does NOT propagate out of the scheduler callback (caught + logged)', async () => {
    const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
    const repos = new FakeRepos(repo);
    const scheduler = new FakeScheduler();
    const fake = new FakeAnalyze();
    fake.result = Promise.reject(new Error('install failed'));
    const analyze = fake as unknown as AnalyzeRepositoryCoverage;
    const useCase = new RequestRepositoryAnalysis(repos, scheduler, analyze);

    await useCase.execute({ repositoryId: repo.id });
    // The scheduler-fired callback must not bubble exceptions — the analyze
    // use case marks the repo failed itself; we only log.
    await expect(scheduler.scheduled[0].run()).resolves.toBeUndefined();
  });

  describe('idempotency guard', () => {
    it('returns current state without re-enqueueing when status is pending', async () => {
      const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      const repos = new FakeRepos(repo);
      const scheduler = new FakeScheduler();
      const analyze = new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage;
      const useCase = new RequestRepositoryAnalysis(repos, scheduler, analyze);

      const dto = await useCase.execute({ repositoryId: repo.id });
      expect(dto.analysisStatus).toBe('pending');
      // Nothing was persisted or enqueued by the duplicate request — the
      // earlier in-flight request already did both.
      expect(repos.saved).toHaveLength(0);
      expect(scheduler.scheduled).toHaveLength(0);
    });

    it('returns current state without re-enqueueing when status is running', async () => {
      const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      repo.markAnalysisRunning();
      const repos = new FakeRepos(repo);
      const scheduler = new FakeScheduler();
      const analyze = new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage;
      const useCase = new RequestRepositoryAnalysis(repos, scheduler, analyze);

      const dto = await useCase.execute({ repositoryId: repo.id });
      expect(dto.analysisStatus).toBe('running');
      expect(repos.saved).toHaveLength(0);
      expect(scheduler.scheduled).toHaveLength(0);
    });

    it('admits a request from idle (initial) state', async () => {
      const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      const repos = new FakeRepos(repo);
      const useCase = new RequestRepositoryAnalysis(
        repos,
        new FakeScheduler(),
        new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage,
      );
      const dto = await useCase.execute({ repositoryId: repo.id });
      expect(dto.analysisStatus).toBe('pending');
    });

    it('admits a retry after a failure (status=failed → pending)', async () => {
      const repo = Repository.create({ owner: 'o', name: 'n', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      repo.markAnalysisRunning();
      repo.markAnalysisFailed('npm install timed out');
      const repos = new FakeRepos(repo);
      const useCase = new RequestRepositoryAnalysis(
        repos,
        new FakeScheduler(),
        new FakeAnalyze() as unknown as AnalyzeRepositoryCoverage,
      );

      const dto = await useCase.execute({ repositoryId: repo.id });
      expect(dto.analysisStatus).toBe('pending');
      expect(dto.analysisError).toBeNull();
    });
  });
});
