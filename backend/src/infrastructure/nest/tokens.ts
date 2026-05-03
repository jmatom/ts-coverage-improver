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
  TestGenerator: 'TestGenerator',
  CoverageRunnerPort: 'CoverageRunnerPort',
  TestSuiteValidator: 'TestSuiteValidator',
  AgentConfigScrubber: 'AgentConfigScrubber',
  SiblingTestPathFinder: 'SiblingTestPathFinder',
  TestConventionDetector: 'TestConventionDetector',
  JobScheduler: 'JobScheduler',
  JobExecutor: 'JobExecutor',
  RepositoryAnalysisScheduler: 'RepositoryAnalysisScheduler',
  Config: 'Config',
  SqliteConnection: 'SqliteConnection',
} as const;
