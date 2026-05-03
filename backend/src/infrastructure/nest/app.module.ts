import { Inject, Module, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { TOKENS } from './tokens';
import { GitHubPort } from '@domain/ports/GitHubPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { AppConfig, loadAppConfig } from './AppConfig';
import { SqliteConnection } from '@infrastructure/persistence/SqliteConnection';
import { SqliteRepositoryRepository } from '@infrastructure/persistence/SqliteRepositoryRepository';
import { SqliteCoverageReportRepository } from '@infrastructure/persistence/SqliteCoverageReportRepository';
import { SqliteJobRepository } from '@infrastructure/persistence/SqliteJobRepository';
import { OctokitGitHub } from '@infrastructure/github/OctokitGitHub';
import { SimpleGit } from '@infrastructure/git/SimpleGit';
import { DockerSandbox } from '@infrastructure/sandbox/DockerSandbox';
import { NpmCoverageRunner } from '@infrastructure/coverage/NpmCoverageRunner';
import { AstTestSuiteValidator } from '@infrastructure/validation/AstTestSuiteValidator';
import { FsAgentConfigScrubber } from '@infrastructure/workdir/FsAgentConfigScrubber';
import { FsSiblingTestPathFinder } from '@infrastructure/workdir/FsSiblingTestPathFinder';
import { FsTestConventionDetector } from '@infrastructure/workdir/FsTestConventionDetector';
import { selectAiAdapter, resolveAiEnv } from '@infrastructure/ai/aiAdapterRegistry';
import { InMemoryPerRepoQueue } from '@infrastructure/queue/InMemoryPerRepoQueue';
import { Semaphore } from '@infrastructure/concurrency/Semaphore';
import { SemaphoreSandbox } from '@infrastructure/concurrency/SemaphoreSandbox';
import { SemaphoreAiAdapter } from '@infrastructure/concurrency/SemaphoreAiAdapter';
import { TestGenerator } from '@domain/ports/TestGeneratorPort';
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

@Module({
  controllers: [RepositoriesController, JobsController, ConfigController],
  providers: [
    {
      provide: TOKENS.Config,
      useFactory: () => loadAppConfig(),
    },
    {
      provide: TOKENS.SqliteConnection,
      useFactory: (config: AppConfig) => {
        const conn = new SqliteConnection(config.databasePath);
        const applied = conn.applyMigrations(join(__dirname, '../../../migrations'));
        if (applied.length) {
          new Logger('SqliteConnection').log(`Applied migrations: ${applied.join(', ')}`);
        }
        const log = new Logger('SqliteConnection');
        const jobsRes = conn.reconcileOrphanRunningJobs();
        if (jobsRes.requeued > 0) {
          log.warn(
            `Crash recovery: re-enqueued ${jobsRes.requeued} interrupted improvement job(s) for one auto-retry`,
          );
        }
        if (jobsRes.failed > 0) {
          log.warn(
            `Crash recovery: marked ${jobsRes.failed} improvement job(s) as failed (auto-retry budget exhausted)`,
          );
        }
        const reposRes = conn.reconcileOrphanRunningAnalyses();
        if (reposRes.requeued > 0) {
          log.warn(
            `Crash recovery: re-enqueued ${reposRes.requeued} interrupted analysis(es) for one auto-retry`,
          );
        }
        if (reposRes.failed > 0) {
          log.warn(
            `Crash recovery: marked ${reposRes.failed} analysis(es) as failed (auto-retry budget exhausted)`,
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
      inject: [TOKENS.SqliteConnection],
    },
    {
      provide: TOKENS.CoverageReportRepository,
      useFactory: (c: SqliteConnection) => new SqliteCoverageReportRepository(c.db),
      inject: [TOKENS.SqliteConnection],
    },
    {
      provide: TOKENS.JobRepository,
      useFactory: (c: SqliteConnection) => new SqliteJobRepository(c.db),
      inject: [TOKENS.SqliteConnection],
    },

    // Outbound adapters
    {
      provide: TOKENS.GitHubPort,
      useFactory: (config: AppConfig) => new OctokitGitHub(config.githubToken),
      inject: [TOKENS.Config],
    },
    {
      provide: TOKENS.GitPort,
      useFactory: () => new SimpleGit(),
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
      useFactory: (sandbox: DockerSandbox) => new NpmCoverageRunner(sandbox),
      inject: [TOKENS.SandboxPort],
    },
    {
      provide: TOKENS.TestSuiteValidator,
      useFactory: () => new AstTestSuiteValidator(),
    },
    // Workdir-bound port adapters — pure fs operations behind ports so
    // the use cases stay free of `node:fs` knowledge and tests can swap
    // in fakes that don't touch a real workdir.
    {
      provide: TOKENS.AgentConfigScrubber,
      useFactory: () => new FsAgentConfigScrubber(),
    },
    {
      provide: TOKENS.SiblingTestPathFinder,
      useFactory: () => new FsSiblingTestPathFinder(),
    },
    {
      provide: TOKENS.TestConventionDetector,
      useFactory: () => new FsTestConventionDetector(),
    },
    {
      provide: TOKENS.TestGenerator,
      useFactory: (config: AppConfig, sandbox: SandboxPort): TestGenerator => {
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
        github: OctokitGitHub,
        git: SimpleGit,
        ai: ReturnType<typeof selectAiAdapter>,
        coverageRunner: NpmCoverageRunner,
        validator: AstTestSuiteValidator,
        agentConfigScrubber: FsAgentConfigScrubber,
        siblingTestPathFinder: FsSiblingTestPathFinder,
        testConventionDetector: FsTestConventionDetector,
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
          agentConfigScrubber,
          siblingTestPathFinder,
          testConventionDetector,
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
        TOKENS.TestGenerator,
        TOKENS.CoverageRunnerPort,
        TOKENS.TestSuiteValidator,
        TOKENS.AgentConfigScrubber,
        TOKENS.SiblingTestPathFinder,
        TOKENS.TestConventionDetector,
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
      useFactory: (repos: SqliteRepositoryRepository, github: OctokitGitHub) =>
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
        git: SimpleGit,
        runner: NpmCoverageRunner,
        siblingTestPathFinder: FsSiblingTestPathFinder,
        config: AppConfig,
      ) =>
        new AnalyzeRepositoryCoverage({
          repos,
          reports,
          git,
          coverageRunner: runner,
          siblingTestPathFinder,
          jobWorkdirRoot: config.jobWorkdirRoot,
          githubToken: config.githubToken,
        }),
      inject: [
        TOKENS.RepositoryRepository,
        TOKENS.CoverageReportRepository,
        TOKENS.GitPort,
        TOKENS.CoverageRunnerPort,
        TOKENS.SiblingTestPathFinder,
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
export class AppModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AppModule');

  constructor(
    @Inject(TOKENS.GitHubPort) private readonly github: GitHubPort,
    @Inject(TOKENS.SandboxPort) private readonly sandbox: SandboxPort,
    @Inject(TOKENS.JobScheduler) private readonly queue: InMemoryPerRepoQueue,
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

  /**
   * Graceful shutdown: stop accepting new work (Nest already closed the
   * HTTP server before this hook fires) and wait for the per-repo queue
   * to drain, capped by `SHUTDOWN_DRAIN_MS` (default 10s).
   *
   * This is a niceness — if the timer expires before the queue drains,
   * any still-running rows will be picked up by the next boot's
   * reconciler (one free auto-retry). Correctness does not depend on
   * the wait completing.
   */
  async onModuleDestroy(): Promise<void> {
    const drainMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? 10_000);
    this.logger.log(`Shutdown signal received — draining queue (up to ${drainMs}ms)`);
    const drained = this.queue
      .waitForAllIdle()
      .then(() => 'drained' as const);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), drainMs).unref(),
    );
    const outcome = await Promise.race([drained, timeout]);
    if (outcome === 'drained') {
      this.logger.log('Queue drained cleanly');
    } else {
      this.logger.warn(
        `Drain deadline (${drainMs}ms) elapsed; in-flight work will be auto-recovered on next boot`,
      );
    }
  }
}
