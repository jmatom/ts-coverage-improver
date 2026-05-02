import { JobRepository } from '@domain/ports/JobRepository';
import { JobDetailDto } from '../dto/Dto';
import { jobToDetailDto } from './_jobMapping';

export class GetJobStatus {
  constructor(private readonly jobs: JobRepository) {}

  async execute(input: { jobId: string }): Promise<JobDetailDto | null> {
    const job = await this.jobs.findById(input.jobId);
    if (!job) return null;
    const logs = await this.jobs.readLogs(job.id);
    return jobToDetailDto(job, logs);
  }
}
