// Domain layer barrel — re-exports for convenience inside `application/`.
// Keep this file free of implementation imports; only re-export domain types.

export * from './repository/Repository';
export * from './coverage/FileCoverage';
export * from './coverage/CoverageReport';
export * from './coverage/LcovParser';
export * from './job/JobStatus';
export * from './job/ImprovementJob';
export * from './services/CoverageAnalyzer';
export * from './services/JobScheduler';
export * from './ports/RepositoryRepository';
export * from './ports/CoverageReportRepository';
export * from './ports/JobRepository';
export * from './ports/GitHubPort';
export * from './ports/SandboxPort';
export * from './ports/GitPort';
export * from './ports/TestSuiteValidatorPort';
export * from './job/testFileNaming';
export * from './errors/DomainError';
export * from './ports/TestGeneratorPort';
export * from './ports/CoverageRunnerPort';
