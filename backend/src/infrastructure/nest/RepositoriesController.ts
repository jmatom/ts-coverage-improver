import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CoverageThreshold } from '@domain/coverage/CoverageThreshold';
import { RepositoryId } from '@domain/repository/RepositoryId';
import { RegisterRepository } from '@application/usecases/RegisterRepository';
import { ListRepositories } from '@application/usecases/ListRepositories';
import { ListLowCoverageFiles } from '@application/usecases/ListLowCoverageFiles';
import { RequestRepositoryAnalysis } from '@application/usecases/RequestRepositoryAnalysis';
import { RequestImprovementJob } from '@application/usecases/RequestImprovementJob';
import { DeleteRepository } from '@application/usecases/DeleteRepository';
import { RegisterRepositoryRequestDto } from './dto/RegisterRepositoryRequestDto';
import { RequestImprovementJobRequestDto } from './dto/RequestImprovementJobRequestDto';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { RepositoryNotFoundError } from '@domain/errors/DomainError';
import { AppConfig } from './AppConfig';
import { TOKENS } from './tokens';

@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly register: RegisterRepository,
    private readonly listAll: ListRepositories,
    private readonly listLow: ListLowCoverageFiles,
    private readonly requestAnalysis: RequestRepositoryAnalysis,
    private readonly requestJob: RequestImprovementJob,
    private readonly removeRepo: DeleteRepository,
    @Inject(TOKENS.RepositoryRepository) private readonly repos: RepositoryRepository,
    @Inject(TOKENS.Config) private readonly config: AppConfig,
  ) {}

  @Post()
  async create(@Body() body: RegisterRepositoryRequestDto) {
    return this.register.execute({ url: body.url, subpath: body.subpath });
  }

  @Get()
  async list() {
    return this.listAll.execute();
  }

  @Get(':id/files')
  async files(
    @Param('id') id: string,
    @Query('threshold') threshold?: string,
  ) {
    const repoId = RepositoryId.of(id);
    await this.assertRepoExists(repoId);
    return this.listLow.execute({
      repositoryId: repoId,
      threshold: CoverageThreshold.fromInput(threshold, this.config.defaultCoverageThreshold),
    });
  }

  @Post(':id/refresh')
  @HttpCode(202)
  async refresh(@Param('id') id: string) {
    const repoId = RepositoryId.of(id);
    await this.assertRepoExists(repoId);
    // Returns 202 immediately with the repo summary in the new "pending"
    // state. The actual analysis (clone + install + tests, can take
    // minutes) runs on the per-repo queue worker. The dashboard polls
    // GET /repositories to observe the status transition.
    return this.requestAnalysis.execute({ repositoryId: repoId });
  }

  @Post(':id/jobs')
  async createJob(
    @Param('id') id: string,
    @Body() body: RequestImprovementJobRequestDto,
  ) {
    const repoId = RepositoryId.of(id);
    await this.assertRepoExists(repoId);
    return this.requestJob.execute({
      repositoryId: repoId,
      targetFilePath: body.filePath,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.removeRepo.execute({ id: RepositoryId.of(id) });
  }

  private async assertRepoExists(id: RepositoryId): Promise<void> {
    const r = await this.repos.findById(id);
    if (!r) throw new RepositoryNotFoundError(id.value);
  }
}
