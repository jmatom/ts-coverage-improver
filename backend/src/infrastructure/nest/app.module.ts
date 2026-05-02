import { Inject, Module, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import { TOKENS } from './tokens';
import { GitHubPort } from '@domain/ports/GitHubPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { AppConfig, loadAppConfig } from './AppConfig';
import { SqliteConnection } from '@infrastructure/persistence/SqliteConnection';
import { SqliteRepositoryRepository } from '@infrastructure/persistence/SqliteRepositoryRepository';
import { SqliteCoverageReportRepository } from '@infrastructure/persistence/SqliteCoverageReportRepository';
import { SqliteJobRepository } from '@infrastructure/persistence/SqliteJobRepository';
import { OctokitGitHubAdapter } from '@infrastructure/github/OctokitGitHubAdapter';
import { SimpleGitCloner } from '@infrastructure/git/SimpleGitCloner';
import { DockerSandbox } from '@infrastructure/sandbox/DockerSandbox';
import { NpmTestRunner } from '@infrastructure/coverage/NpmTestRunner';
import { AstTestValidator } from '@infrastructure/validation/AstTestValidator';
import { selectAiAdapter, resolveAiEnv } from '@infrastructure/ai/aiAdapterRegistry';
import { InMemoryPerRepoQueue } from '@infrastructure/queue/InMemoryPerRepoQueue';
import { Semaphore } from '@infrastructure/concurrency/Semaphore';
import { SemaphoreSandbox } from '@infrastructure/concurrency/SemaphoreSandbox';
import { SemaphoreAiAdapter } from '@infrastructure/concurrency/SemaphoreAiAdapter';
import { AICliPort } from '@domain/ports/AICliPort';
import { RegisterRepository } from '@application/usecases/RegisterRepository';
import { ListRepositories } from '@application/usecases/ListRepositories';
import { ListLowCoverageFiles } from '@application/usecases/ListLowCoverageFiles';
import { RequestImprovementJob } from '@application/usecases/RequestImprovementJob';
import { GetJobStatus } from '@application/usecases/GetJobStatus';
import { ListJobs } from '@application/usecases/ListJobs';
import { AnalyzeRepositoryCoverage } from '@application/usecases/AnalyzeRepositoryCoverage';
import { RequestRepositoryAnalysis } from '@application/usecases/RequestRepositoryAnalysis';
import { RecoverPendingWork } from '@application/usecases/RecoverPendingWork';
import { RunImprovementJob } from '@application/usecases/RunImprovementJob';
import { DeleteRepository } from '@application/usecases/DeleteRepository';
import { DeleteJob } from '@application/usecases/DeleteJob';
import { RepositoriesController } from './RepositoriesController';
import { JobsController } from './JobsController';
import { ConfigController } from './ConfigController';

const SQLITE_CONNECTION = 'SqliteConnection';

@Module({
  controllers: [RepositoriesController, JobsController, ConfigController],
  providers: [
    {
      provide: TOKENS.Config,
      useFactory: () => loadAppConfig(),
    },
    {
      provide: SQLITE_CONNECTION,
      useFactory: (config: AppConfig) => {
        const conn = new SqliteConnection(config.databasePath);
        const applied = conn.applyMigrations(join(__dirname, '../../../migrations'));
        if (applied.length) {
          new Logger('SqliteConnection').log(`Applied migrations: ${applied.join(', ')}`);
        }
        const reconciled = conn.reconcileOrphanRunningJobs();
        if (reconciled > 0) {
          new Logger('SqliteConnection').warn(
            `Reconciled ${reconciled} orphan running job(s) at boot`,
          );
        }
        const reconciledRepos = conn.reconcileOrphanRunningAnalyses();
        if (reconciledRepos > 0) {
          new Logger('SqliteConnection').warn(
            `Reconciled ${reconciledRepos} orphan running analysis state(s) at boot`,
          );
        }
        return conn;
      },
      inject: [TOKENS.Config],
    },

    // Persistence adapters
    {
      provide: TOKENS.RepositoryRepository,
      useFactory: (c: SqliteConnection) => new SqliteRepositoryRepository(c.db),
      inject: [SQLITE_CONNECTION],
    },
    {
      provide: TOKENS.CoverageReportRepository,
      useFactory: (c: SqliteConnection) => new SqliteCoverageReportRepository(c.db),
      inject: [SQLITE_CONNECTION],
    },
    {
      provide: TOKENS.JobRepository,
      useFactory: (c: SqliteConnection) => new SqliteJobRepository(c.db),
      inject: [SQLITE_CONNECTION],
    },

    // Outbound adapters
    {
      provide: TOKENS.GitHubPort,
      useFactory: (config: AppConfig) => new OctokitGitHubAdapter(config.githubToken),
      inject: [TOKENS.Config],
    },
    {
      provide: TOKENS.GitPort,
      useFactory: () => new SimpleGitCloner(),
    },
    {
      provide: TOKENS.SandboxPort,
      useFactory: (config: AppConfig): SandboxPort => {
        const inner = new DockerSandbox({
          image: config.sandboxImage,
          socketPath: config.dockerSocketPath,
        });
        const sem = new Semaphore(config.maxConcurrentSandboxes);
        new Logger('Concurrency').log(
          `Sandbox concurrency cap: ${config.maxConcurrentSandboxes}`,
        );
        return new SemaphoreSandbox(inner, sem);
      },
      inject: [TOKENS.Config],
    },
    {
      provide: TOKENS.CoverageRunnerPort,
      useFactory: (sandbox: DockerSandbox) => new NpmTestRunner(sandbox),
      inject: [TOKENS.SandboxPort],
    },
    {
      provide: TOKENS.TestSuiteValidator,
      useFactory: () => new AstTestValidator(),
    },
    {
      provide: TOKENS.AICliPort,
      useFactory: (config: AppConfig, sandbox: SandboxPort): AICliPort => {
        const adapter = selectAiAdapter(config.aiCli, sandbox, config.rawEnv);
        new Logger('AiModule').log(
          `Selected AI adapter: ${adapter.id} (requires: ${adapter.requiredEnv.join(', ')})`,
        );
        const sem = new Semaphore(config.maxConcurrentAiCalls);
        new Logger('Concurrency').log(
          `AI concurrency cap: ${config.maxConcurrentAiCalls}`,
        );
        return new SemaphoreAiAdapter(adapter, sem);
      },
      inject: [TOKENS.Config, TOKENS.SandboxPort],
    },

    // Job execution + scheduling — Day-2 real RunImprovementJob.
    {
      provide: TOKENS.JobExecutor,
      useFactory: (
        jobs: SqliteJobRepository,
        repos: SqliteRepositoryRepository,
        reports: SqliteCoverageReportRepository,
        github: OctokitGitHubAdapter,
        git: SimpleGitCloner,
        ai: ReturnType<typeof selectAiAdapter>,
        coverageRunner: NpmTestRunner,
        validator: AstTestValidator,
        config: AppConfig,
      ) =>
        new RunImprovementJob({
          jobs,
          repos,
          reports,
          github,
          git,
          ai,
          coverageRunner,
          validator,
          jobWorkdirRoot: config.jobWorkdirRoot,
          githubToken: config.githubToken,
          resolveAiEnv: (required) =>
            resolveAiEnv(required, ai.optionalEnv, config.rawEnv),
        }),
      inject: [
        TOKENS.JobRepository,
        TOKENS.RepositoryRepository,
        TOKENS.CoverageReportRepository,
        TOKENS.GitHubPort,
        TOKENS.GitPort,
        TOKENS.AICliPort,
        TOKENS.CoverageRunnerPort,
        TOKENS.TestSuiteValidator,
        TOKENS.Config,
      ],
    },
    {
      provide: TOKENS.JobScheduler,
      useFactory: (executor: RunImprovementJob, jobs: SqliteJobRepository) =>
        new InMemoryPerRepoQueue(executor, jobs),
      inject: [TOKENS.JobExecutor, TOKENS.JobRepository],
    },
    // Same physical queue instance also satisfies the analysis scheduler
    // port. Both improvement jobs and analyze-coverage runs share a single
    // `Map<repoId, Promise>` chain — they're serialized per-repo against
    // each other, which is the correct invariant since both contend for
    // the cloned workdir.
    {
      provide: TOKENS.RepositoryAnalysisScheduler,
      useExisting: TOKENS.JobScheduler,
    },

    // Use cases
    {
      provide: RegisterRepository,
      useFactory: (repos: SqliteRepositoryRepository, github: OctokitGitHubAdapter) =>
        new RegisterRepository(repos, github),
      inject: [TOKENS.RepositoryRepository, TOKENS.GitHubPort],
    },
    {
      provide: ListRepositories,
      useFactory: (
        repos: SqliteRepositoryRepository,
        reports: SqliteCoverageReportRepository,
      ) => new ListRepositories(repos, reports),
      inject: [TOKENS.RepositoryRepository, TOKENS.CoverageReportRepository],
    },
    {
      provide: ListLowCoverageFiles,
      useFactory: (reports: SqliteCoverageReportRepository) => new ListLowCoverageFiles(reports),
      inject: [TOKENS.CoverageReportRepository],
    },
    {
      provide: AnalyzeRepositoryCoverage,
      useFactory: (
        repos: SqliteRepositoryRepository,
        reports: SqliteCoverageReportRepository,
        git: SimpleGitCloner,
        runner: NpmTestRunner,
        config: AppConfig,
      ) =>
        new AnalyzeRepositoryCoverage({
          repos,
          reports,
          git,
          coverageRunner: runner,
          jobWorkdirRoot: config.jobWorkdirRoot,
          githubToken: config.githubToken,
        }),
      inject: [
        TOKENS.RepositoryRepository,
        TOKENS.CoverageReportRepository,
        TOKENS.GitPort,
        TOKENS.CoverageRunnerPort,
        TOKENS.Config,
      ],
    },
    {
      provide: RequestRepositoryAnalysis,
      useFactory: (
        repos: SqliteRepositoryRepository,
        scheduler: InMemoryPerRepoQueue,
        analyze: AnalyzeRepositoryCoverage,
      ) => new RequestRepositoryAnalysis(repos, scheduler, analyze),
      inject: [
        TOKENS.RepositoryRepository,
        TOKENS.RepositoryAnalysisScheduler,
        AnalyzeRepositoryCoverage,
      ],
    },
    {
      provide: RequestImprovementJob,
      useFactory: (
        jobs: SqliteJobRepository,
        reports: SqliteCoverageReportRepository,
        scheduler: InMemoryPerRepoQueue,
        config: AppConfig,
      ) =>
        new RequestImprovementJob(jobs, reports, scheduler, {
          maxQueueDepth: config.maxQueueDepth,
        }),
      inject: [
        TOKENS.JobRepository,
        TOKENS.CoverageReportRepository,
        TOKENS.JobScheduler,
        TOKENS.Config,
      ],
    },
    {
      provide: RecoverPendingWork,
      useFactory: (
        jobs: SqliteJobRepository,
        repos: SqliteRepositoryRepository,
        scheduler: InMemoryPerRepoQueue,
        analyze: AnalyzeRepositoryCoverage,
      ) => new RecoverPendingWork(jobs, repos, scheduler, scheduler, analyze),
      inject: [
        TOKENS.JobRepository,
        TOKENS.RepositoryRepository,
        TOKENS.JobScheduler,
        AnalyzeRepositoryCoverage,
      ],
    },
    {
      provide: GetJobStatus,
      useFactory: (jobs: SqliteJobRepository) => new GetJobStatus(jobs),
      inject: [TOKENS.JobRepository],
    },
    {
      provide: ListJobs,
      useFactory: (jobs: SqliteJobRepository) => new ListJobs(jobs),
      inject: [TOKENS.JobRepository],
    },
    {
      provide: DeleteRepository,
      useFactory: (repos: SqliteRepositoryRepository) => new DeleteRepository(repos),
      inject: [TOKENS.RepositoryRepository],
    },
    {
      provide: DeleteJob,
      useFactory: (jobs: SqliteJobRepository) => new DeleteJob(jobs),
      inject: [TOKENS.JobRepository],
    },
  ],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger('AppModule');

  constructor(
    @Inject(TOKENS.GitHubPort) private readonly github: GitHubPort,
    @Inject(TOKENS.SandboxPort) private readonly sandbox: SandboxPort,
    private readonly recover: RecoverPendingWork,
  ) {}

  /**
   * Boot-time validation: surface common misconfigurations BEFORE the first
   * improvement job hits them.
   *  - PAT validity: a single Octokit `users.getAuthenticated` call.
   *  - Sandbox readiness: docker daemon reachable + image present.
   * Either failure throws → Nest aborts boot with a clear message.
   *
   * After validation passes, recover any `pending` work persisted from a
   * previous process. The SqliteConnection factory already handled
   * `running`-row reconciliation (marked them `failed`); this step
   * re-enqueues `pending` rows that never got picked up before the restart.
   */
  async onModuleInit(): Promise<void> {
    const login = await this.github.whoami().catch((e: Error) => {
      throw new Error(
        `GitHub PAT validation failed: ${e.message}. Check GITHUB_TOKEN scope (need 'repo') and that the token has not expired.`,
      );
    });
    this.logger.log(`GitHub auth OK — bot user: ${login}`);

    await this.sandbox.assertReady();
    this.logger.log('Sandbox ready — image present, daemon reachable');

    await this.recover.execute();
  }
}
