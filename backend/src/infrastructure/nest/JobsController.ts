import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
} from '@nestjs/common';
import { GetJobStatus } from '@application/usecases/GetJobStatus';
import { ListJobs } from '@application/usecases/ListJobs';
import { DeleteJob } from '@application/usecases/DeleteJob';
import { JobNotFoundError } from '@domain/errors/DomainError';
import { JobId } from '@domain/job/JobId';
import { RepositoryId } from '@domain/repository/RepositoryId';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly getStatus: GetJobStatus,
    private readonly list: ListJobs,
    private readonly removeJob: DeleteJob,
  ) {}

  @Get()
  async listForRepo(@Query('repositoryId') repositoryId?: string) {
    if (!repositoryId) throw new BadRequestException('repositoryId query param is required');
    return this.list.execute({ repositoryId: RepositoryId.of(repositoryId) });
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const jobId = JobId.of(id);
    const detail = await this.getStatus.execute({ jobId });
    if (!detail) throw new JobNotFoundError(id);
    return detail;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.removeJob.execute({ id: JobId.of(id) });
  }
}
