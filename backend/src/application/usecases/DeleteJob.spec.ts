import { DeleteJob } from './DeleteJob';
import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobRepository } from '@domain/ports/JobRepository';
import {
  CannotDeleteInFlightJobError,
  JobNotFoundError,
} from '@domain/errors/DomainError';

function makeJob(status: 'pending' | 'running' | 'succeeded' | 'failed'): ImprovementJob {
  return ImprovementJob.rehydrate({
    id: 'job-id-1234',
    repositoryId: 'repo-1',
    targetFilePath: 'src/foo.ts',
    status,
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
    delete: jest.fn().mockResolvedValue(undefined),
    countActive: jest.fn(),
    ...overrides,
  };
}

describe('DeleteJob', () => {
  it('throws JobNotFoundError when the job does not exist', async () => {
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
    const useCase = new DeleteJob(repo);

    await expect(useCase.execute({ id: 'missing-id' })).rejects.toThrow(JobNotFoundError);
  });

  it('throws CannotDeleteInFlightJobError when the job is pending', async () => {
    const job = makeJob('pending');
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(job) });
    const useCase = new DeleteJob(repo);

    await expect(useCase.execute({ id: job.id })).rejects.toThrow(CannotDeleteInFlightJobError);
  });

  it('throws CannotDeleteInFlightJobError when the job is running', async () => {
    const job = makeJob('running');
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(job) });
    const useCase = new DeleteJob(repo);

    await expect(useCase.execute({ id: job.id })).rejects.toThrow(CannotDeleteInFlightJobError);
  });

  it('deletes a succeeded job without throwing', async () => {
    const job = makeJob('succeeded');
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(job), delete: deleteFn });
    const useCase = new DeleteJob(repo);

    await expect(useCase.execute({ id: job.id })).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalledWith(job.id);
  });

  it('deletes a failed job without throwing', async () => {
    const job = makeJob('failed');
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(job), delete: deleteFn });
    const useCase = new DeleteJob(repo);

    await expect(useCase.execute({ id: job.id })).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalledWith(job.id);
  });
});
