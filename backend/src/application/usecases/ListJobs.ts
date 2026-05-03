import { RepositoryId } from '@domain/repository/RepositoryId';
import { JobRepository } from '@domain/ports/JobRepository';
import { JobDto } from '../dto/Dto';
import { jobToDto } from './_jobMapping';

export class ListJobs {
  constructor(private readonly jobs: JobRepository) {}

  async execute(input: { repositoryId: RepositoryId }): Promise<JobDto[]> {
    const list = await this.jobs.listByRepository(input.repositoryId);
    return list.map(jobToDto);
  }
}
