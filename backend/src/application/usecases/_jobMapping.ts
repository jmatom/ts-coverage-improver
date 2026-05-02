import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobDetailDto, JobDto } from '../dto/Dto';

export function jobToDto(job: ImprovementJob): JobDto {
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    targetFilePath: job.targetFilePath,
    status: job.status,
    mode: job.mode,
    prUrl: job.prUrl,
    coverageBefore: job.coverageBefore,
    coverageAfter: job.coverageAfter,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export function jobToDetailDto(job: ImprovementJob, logs: string[]): JobDetailDto {
  return { ...jobToDto(job), logs };
}
