import { ListRepositories } from './ListRepositories';
import { Repository } from '@domain/repository/Repository';
import { CoverageReport } from '@domain/coverage/CoverageReport';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';

function makeRepository(overrides: Partial<Parameters<typeof Repository.rehydrate>[0]> = {}): Repository {
  return Repository.rehydrate({
    id: 'repo-1',
    owner: 'acme',
    name: 'my-repo',
    defaultBranch: 'main',
    forkOwner: null,
    lastAnalyzedAt: null,
    subpath: '',
    analysisStatus: 'idle',
    analysisError: null,
    analysisStartedAt: null,
    analysisAutoRetryCount: 0,
    ...overrides,
  });
}

function makeCoverageReport(overallPct: number, fileCount = 1): CoverageReport {
  return {
    overallLinesPct: () => overallPct,
    files: new Array(fileCount).fill({}),
  } as unknown as CoverageReport;
}

function makeRepoRepository(overrides: Partial<RepositoryRepository> = {}): RepositoryRepository {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findByOwnerAndName: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    findByAnalysisStatus: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  };
}

function makeCoverageReportRepository(overrides: Partial<CoverageReportRepository> = {}): CoverageReportRepository {
  return {
    save: jest.fn(),
    findLatestByRepository: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('ListRepositories', () => {
  it('returns an empty array when no repositories exist', async () => {
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([]) });
    const reports = makeCoverageReportRepository();
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result).toEqual([]);
  });

  it('returns a summary with null coverage fields when no report exists for the repository', async () => {
    const repo = makeRepository();
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo]) });
    const reports = makeCoverageReportRepository({ findLatestByRepository: jest.fn().mockResolvedValue(null) });
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    expect(result[0].overallLinesPct).toBeNull();
    expect(result[0].fileCount).toBe(0);
  });

  it('returns a summary with coverage data when a report exists for the repository', async () => {
    const repo = makeRepository({ id: 'repo-1', owner: 'acme', name: 'my-repo' });
    const report = makeCoverageReport(85.5, 3);
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo]) });
    const reports = makeCoverageReportRepository({
      findLatestByRepository: jest.fn().mockResolvedValue(report),
    });
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result[0].overallLinesPct).toBe(85.5);
    expect(result[0].fileCount).toBe(3);
  });

  it('includes lastAnalyzedAt as ISO string when the repository has been analyzed', async () => {
    const analyzedAt = new Date('2024-06-15T10:00:00.000Z');
    const repo = makeRepository({ lastAnalyzedAt: analyzedAt });
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo]) });
    const reports = makeCoverageReportRepository();
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result[0].lastAnalyzedAt).toBe('2024-06-15T10:00:00.000Z');
  });

  it('sets lastAnalyzedAt to null when the repository has never been analyzed', async () => {
    const repo = makeRepository({ lastAnalyzedAt: null });
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo]) });
    const reports = makeCoverageReportRepository();
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result[0].lastAnalyzedAt).toBeNull();
  });

  it('rounds overallLinesPct to 2 decimal places', async () => {
    const repo = makeRepository();
    const report = makeCoverageReport(66.6666666);
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo]) });
    const reports = makeCoverageReportRepository({
      findLatestByRepository: jest.fn().mockResolvedValue(report),
    });
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result[0].overallLinesPct).toBe(66.67);
  });

  it('maps all repository fields onto the summary dto', async () => {
    const startedAt = new Date('2024-06-01T08:00:00.000Z');
    const repo = makeRepository({
      id: 'repo-42',
      owner: 'org',
      name: 'project',
      defaultBranch: 'develop',
      forkOwner: 'bot-user',
      subpath: 'packages/core',
      analysisStatus: 'failed',
      analysisError: 'timeout',
      analysisStartedAt: startedAt,
    });
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo]) });
    const reports = makeCoverageReportRepository();
    const useCase = new ListRepositories(repos, reports);

    const result = await useCase.execute();

    expect(result[0]).toMatchObject({
      id: 'repo-42',
      owner: 'org',
      name: 'project',
      defaultBranch: 'develop',
      forkOwner: 'bot-user',
      subpath: 'packages/core',
      analysisStatus: 'failed',
      analysisError: 'timeout',
      analysisStartedAt: '2024-06-01T08:00:00.000Z',
    });
  });

  it('queries coverage for each repository individually', async () => {
    const repo1 = makeRepository({ id: 'repo-1' });
    const repo2 = makeRepository({ id: 'repo-2' });
    const findLatest = jest.fn().mockResolvedValue(null);
    const repos = makeRepoRepository({ list: jest.fn().mockResolvedValue([repo1, repo2]) });
    const reports = makeCoverageReportRepository({ findLatestByRepository: findLatest });
    const useCase = new ListRepositories(repos, reports);

    await useCase.execute();

    expect(findLatest).toHaveBeenCalledWith('repo-1');
    expect(findLatest).toHaveBeenCalledWith('repo-2');
    expect(findLatest).toHaveBeenCalledTimes(2);
  });
});
