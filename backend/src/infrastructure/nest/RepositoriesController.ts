import {
  BadRequestException,
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
import { RegisterRepository } from '@application/usecases/RegisterRepository';
import { ListRepositories } from '@application/usecases/ListRepositories';
import { ListLowCoverageFiles } from '@application/usecases/ListLowCoverageFiles';
import { AnalyzeRepositoryCoverage } from '@application/usecases/AnalyzeRepositoryCoverage';
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
    private readonly analyze: AnalyzeRepositoryCoverage,
    private readonly requestJob: RequestImprovementJob,
    private readonly removeRepo: DeleteRepository,
    @Inject(TOKENS.RepositoryRepository) private readonly repos: RepositoryRepository,
    @Inject(TOKENS.Config) private readonly config: AppConfig,
  ) {}

  @Post()
  async create(@Body() body: RegisterRepositoryRequestDto) {
    return this.register.execute({ url: body.url });
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
    await this.assertRepoExists(id);
    const t =
      threshold !== undefined ? Number(threshold) : this.config.defaultCoverageThreshold;
    if (!Number.isFinite(t) || t < 0 || t > 100) {
      throw new BadRequestException('threshold must be in [0, 100]');
    }
    return this.listLow.execute({ repositoryId: id, threshold: t });
  }

  @Post(':id/refresh')
  async refresh(@Param('id') id: string) {
    await this.assertRepoExists(id);
    return this.analyze.execute({ repositoryId: id });
  }

  @Post(':id/jobs')
  async createJob(
    @Param('id') id: string,
    @Body() body: RequestImprovementJobRequestDto,
  ) {
    await this.assertRepoExists(id);
    return this.requestJob.execute({
      repositoryId: id,
      targetFilePath: body.filePath,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.removeRepo.execute({ id });
  }

  private async assertRepoExists(id: string): Promise<void> {
    const r = await this.repos.findById(id);
    if (!r) throw new RepositoryNotFoundError(id);
  }
}
