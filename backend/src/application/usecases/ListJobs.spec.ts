import { ListJobs } from './ListJobs';
import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobRepository } from '@domain/ports/JobRepository';

function makeJob(id: string, repositoryId: string): ImprovementJob {
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
    const repo = makeRepo({ listByRepository: jest.fn().mockResolvedValue([]) });
    const useCase = new ListJobs(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1' });

    expect(result).toEqual([]);
    expect(repo.listByRepository).toHaveBeenCalledWith('repo-1');
  });

  it('returns mapped DTOs for all jobs in the repository', async () => {
    const jobs = [makeJob('job-1', 'repo-1'), makeJob('job-2', 'repo-1')];
    const repo = makeRepo({ listByRepository: jest.fn().mockResolvedValue(jobs) });
    const useCase = new ListJobs(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1' });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('job-1');
    expect(result[1].id).toBe('job-2');
    expect(result[0].repositoryId).toBe('repo-1');
  });
});
