/**
 * DI tokens for ports. We use string tokens (not class identifiers) so that
 * domain interfaces stay framework-free — Nest's @Inject(TOKEN) is the only
 * place these strings appear.
 */
export const TOKENS = {
  RepositoryRepository: 'RepositoryRepository',
  CoverageReportRepository: 'CoverageReportRepository',
  JobRepository: 'JobRepository',
  GitHubPort: 'GitHubPort',
  GitPort: 'GitPort',
  SandboxPort: 'SandboxPort',
  AICliPort: 'AICliPort',
  CoverageRunnerPort: 'CoverageRunnerPort',
  TestSuiteValidator: 'TestSuiteValidator',
  JobScheduler: 'JobScheduler',
  JobExecutor: 'JobExecutor',
  Config: 'AppConfig',
} as const;
