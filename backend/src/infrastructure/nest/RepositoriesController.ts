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

  // Success: 202 (idempotent register). Failures: 400 INVALID_GITHUB_URL,
  // 422 FORKING_DISABLED, 502 UPSTREAM_UNREACHABLE.
  @Post()
  @HttpCode(202)
  async create(@Body() body: RegisterRepositoryRequestDto) {
    // 202: registration is idempotent on (owner, name) — submitting the same
    // URL twice is a no-op-success rather than a 409. The persisted row is
    // returned in `analysisStatus: "idle"`; the dashboard prompts the user
    // to click Re-analyze to populate coverage data. Choosing 202 over 201
    // keeps the controller's async-vs-sync convention consistent: every
    // mutating endpoint here returns 202 because none of them have produced
    // a final user-visible artifact by the time the response is sent.
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

  // Success: 202 (always — pending/running maps to "already in flight"
  // returned as 202 too). Failures: 400 INVALID_REPOSITORY_ID,
  // 404 REPOSITORY_NOT_FOUND.
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

  // Success: 202 (job persisted in pending + enqueued).
  // Failures: 400 INVALID_REPOSITORY_ID, 404 REPOSITORY_NOT_FOUND,
  // 409 JOB_ALREADY_IN_FLIGHT, 422 NO_COVERAGE_REPORT |
  // FILE_NOT_IN_REPORT | FILE_ALREADY_AT_100_PERCENT,
  // 503 QUEUE_DEPTH_EXCEEDED.
  @Post(':id/jobs')
  @HttpCode(202)
  async createJob(
    @Param('id') id: string,
    @Body() body: RequestImprovementJobRequestDto,
  ) {
    const repoId = RepositoryId.of(id);
    await this.assertRepoExists(repoId);
    // Returns 202: the job is persisted in `pending` and enqueued onto
    // the per-repo queue. The actual clone + AI invoke + tests + PR push
    // runs in the background; the dashboard observes via GET /jobs/:id.
    // Same async-honest pattern as /refresh.
    return this.requestJob.execute({
      repositoryId: repoId,
      targetFilePath: body.filePath,
    });
  }

  // Success: 204 (no body). Failures: 400 INVALID_REPOSITORY_ID,
  // 404 REPOSITORY_NOT_FOUND.
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
