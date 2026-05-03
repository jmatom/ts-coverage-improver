import { ListJobs } from './ListJobs';
import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobId } from '@domain/job/JobId';
import { RepositoryId } from '@domain/repository/RepositoryId';
import { JobRepository } from '@domain/ports/JobRepository';

function makeJob(id: JobId, repositoryId: RepositoryId): ImprovementJob {
  return ImprovementJob.rehydrate({
    id,
    repositoryId,
    targetFilePath: 'src/foo.ts',
    status: 'succeeded',
    mode: null,
    prUrl: null,
    coverageBefore: null,
    coverageAfter: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    autoRetryCount: 0,
  });
}

function makeRepo(overrides: Partial<JobRepository> = {}): JobRepository {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    listByRepository: jest.fn(),
    findByStatus: jest.fn(),
    findInFlightForFile: jest.fn(),
    appendLog: jest.fn(),
    readLogs: jest.fn(),
    delete: jest.fn(),
    countActive: jest.fn(),
    ...overrides,
  };
}

describe('ListJobs', () => {
  it('returns an empty array when the repository has no jobs', async () => {
    const repoId = RepositoryId.new();
    const repo = makeRepo({ listByRepository: jest.fn().mockResolvedValue([]) });
    const useCase = new ListJobs(repo);

    const result = await useCase.execute({ repositoryId: repoId });

    expect(result).toEqual([]);
    expect(repo.listByRepository).toHaveBeenCalledWith(repoId);
  });

  it('returns mapped DTOs for all jobs in the repository', async () => {
    const repoId = RepositoryId.new();
    const job1 = makeJob(JobId.new(), repoId);
    const job2 = makeJob(JobId.new(), repoId);
    const repo = makeRepo({ listByRepository: jest.fn().mockResolvedValue([job1, job2]) });
    const useCase = new ListJobs(repo);

    const result = await useCase.execute({ repositoryId: repoId });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(job1.id.value);
    expect(result[1].id).toBe(job2.id.value);
    expect(result[0].repositoryId).toBe(repoId.value);
  });
});
