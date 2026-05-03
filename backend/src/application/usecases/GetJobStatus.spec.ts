import { GetJobStatus } from './GetJobStatus';
import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobId } from '@domain/job/JobId';
import { RepositoryId } from '@domain/repository/RepositoryId';
import { JobRepository } from '@domain/ports/JobRepository';

function makeJob(): ImprovementJob {
  return ImprovementJob.rehydrate({
    id: JobId.new(),
    repositoryId: RepositoryId.new(),
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
    readLogs: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
    countActive: jest.fn(),
    ...overrides,
  };
}

describe('GetJobStatus', () => {
  it('returns null when the job does not exist', async () => {
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
    const useCase = new GetJobStatus(repo);

    const result = await useCase.execute({ jobId: JobId.new() });

    expect(result).toBeNull();
  });

  it('returns a JobDetailDto with logs when the job exists', async () => {
    const job = makeJob();
    const logs = ['line 1', 'line 2'];
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue(job),
      readLogs: jest.fn().mockResolvedValue(logs),
    });
    const useCase = new GetJobStatus(repo);

    const result = await useCase.execute({ jobId: job.id });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(job.id.value);
    expect(result!.logs).toEqual(logs);
  });

  it('calls readLogs with the job id', async () => {
    const job = makeJob();
    const readLogs = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue(job),
      readLogs,
    });
    const useCase = new GetJobStatus(repo);

    await useCase.execute({ jobId: job.id });

    expect(readLogs).toHaveBeenCalledWith(job.id);
  });
});
