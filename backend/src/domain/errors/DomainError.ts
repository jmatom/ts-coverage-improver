/**
 * Base class for domain-level errors that have a stable error `code`.
 *
 * The infrastructure layer maps these codes to HTTP status codes (see
 * DomainExceptionFilter) — the domain itself stays HTTP-agnostic, it only
 * declares the *meaning* of each failure.
 *
 * Throw these from use cases / domain services / detectors when the failure
 * is one we can describe in a single sentence the user will understand.
 * Reserve generic `Error` for genuinely unexpected bugs (those map to 500).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// --- Coverage-runner / framework detection ---------------------------------

export class MissingPackageJsonError extends DomainError {
  readonly code = 'MISSING_PACKAGE_JSON';
  constructor(workdir: string) {
    super(
      `No package.json found at the repository root (${workdir}). The improver only supports Node-based TypeScript projects.`,
    );
  }
}

export class UnsupportedTestFrameworkError extends DomainError {
  readonly code = 'UNSUPPORTED_TEST_FRAMEWORK';
  constructor(public readonly detected: readonly string[]) {
    super(
      `Unsupported test framework: expected one of jest/vitest/mocha in devDependencies. ` +
        (detected.length
          ? `Detected: ${detected.join(', ')}.`
          : `No test-framework devDependency found.`),
    );
  }
}

export class MissingMochaCoverageToolError extends DomainError {
  readonly code = 'MISSING_MOCHA_COVERAGE_TOOL';
  constructor() {
    super(
      `Mocha detected but no coverage tool (\`c8\` or \`nyc\`) found in devDependencies. ` +
        `Add one of them to the project before re-analyzing.`,
    );
  }
}

// --- Repository registration / GitHub ---------------------------------------

export class UpstreamRepoUnreachableError extends DomainError {
  readonly code = 'UPSTREAM_UNREACHABLE';
  constructor(fullName: string, cause: string) {
    super(
      `Cannot reach upstream repository ${fullName}: ${cause}. ` +
        `The repo may have been deleted, renamed, made private, or your GITHUB_TOKEN lost access.`,
    );
  }
}

export class ForkingDisabledError extends DomainError {
  readonly code = 'FORKING_DISABLED';
  constructor(fullName: string) {
    super(
      `Repository ${fullName} disallows forking — the fork-and-PR flow can't be used. ` +
        `Ask the repo owner to enable forks, or pick a different target.`,
    );
  }
}

export class InvalidGitHubUrlError extends DomainError {
  readonly code = 'INVALID_GITHUB_URL';
  constructor(url: string) {
    super(`Unsupported repository URL: ${url}. Expected something like https://github.com/owner/repo.`);
  }
}

// --- Boundary input shape errors (HTTP 400) --------------------------------
//
// Thrown by VO constructors at the controller boundary when the raw input
// (path param, query string, body field) doesn't parse into a valid VO.
// Distinct from `DomainInvariantError` (which signals a programmer bug — a
// caller inside the trusted application/domain layer passing nonsense), so
// the filter can map these to 400 (client-malformed input) and reserve 500
// for genuine invariant violations.

export class InvalidRepositoryIdError extends DomainError {
  readonly code = 'INVALID_REPOSITORY_ID';
  constructor(raw: unknown) {
    super(`RepositoryId must be a UUID; got '${String(raw)}'`);
  }
}

export class InvalidJobIdError extends DomainError {
  readonly code = 'INVALID_JOB_ID';
  constructor(raw: unknown) {
    super(`JobId must be a UUID; got '${String(raw)}'`);
  }
}

export class InvalidCoverageThresholdError extends DomainError {
  readonly code = 'INVALID_COVERAGE_THRESHOLD';
  constructor(value: unknown) {
    super(`CoverageThreshold must be a finite number in [0, 100]; got ${String(value)}`);
  }
}

// --- Improvement-job request ------------------------------------------------

export class NoCoverageReportError extends DomainError {
  readonly code = 'NO_COVERAGE_REPORT';
  constructor(repositoryId: string) {
    super(
      `No coverage report yet for repository ${repositoryId}. Click Re-analyze first to scan the repo.`,
    );
  }
}

export class FileNotInLatestReportError extends DomainError {
  readonly code = 'FILE_NOT_IN_REPORT';
  constructor(targetFilePath: string) {
    super(
      `File '${targetFilePath}' not found in the latest coverage report. ` +
        `It may have been added/renamed after the last analysis — Re-analyze and try again.`,
    );
  }
}

export class FileAlreadyFullyCoveredError extends DomainError {
  readonly code = 'FILE_ALREADY_AT_100_PERCENT';
  constructor(targetFilePath: string) {
    super(`File '${targetFilePath}' is already at 100% line coverage — nothing to improve.`);
  }
}

export class JobAlreadyInFlightError extends DomainError {
  readonly code = 'JOB_ALREADY_IN_FLIGHT';
  constructor(targetFilePath: string, public readonly existingJobId: string) {
    super(
      `An improvement job for '${targetFilePath}' is already pending or running ` +
        `(job ${existingJobId.slice(0, 8)}). Wait for it to finish before queueing another.`,
    );
  }
}

export class CannotDeleteInFlightJobError extends DomainError {
  readonly code = 'CANNOT_DELETE_IN_FLIGHT_JOB';
  constructor(jobId: string) {
    super(
      `Job ${jobId.slice(0, 8)} is still pending or running — wait for it to finish before deleting it.`,
    );
  }
}

/**
 * The system is at its configured capacity for active improvement jobs.
 * Surfaces as HTTP 503; the dashboard can show a friendly "try again later"
 * message and/or include a Retry-After header.
 */
export class QueueDepthExceededError extends DomainError {
  readonly code = 'QUEUE_DEPTH_EXCEEDED';
  constructor(public readonly active: number, public readonly limit: number) {
    super(
      `System is busy — ${active} jobs are currently pending or running ` +
        `(limit ${limit}). Try again in a moment.`,
    );
  }
}

// --- Aggregate lookups (HTTP 404) -------------------------------------------

export class RepositoryNotFoundError extends DomainError {
  readonly code = 'REPOSITORY_NOT_FOUND';
  constructor(id: string) {
    super(`Repository '${id}' not found.`);
  }
}

export class JobNotFoundError extends DomainError {
  readonly code = 'JOB_NOT_FOUND';
  constructor(id: string) {
    super(`Job '${id}' not found.`);
  }
}

// --- Invariant / state-machine violations -----------------------------------

/**
 * A programmer-error throw from inside a domain aggregate or VO: empty
 * required string, out-of-range value, illegal state transition, etc. These
 * indicate buggy orchestration code, not user-recoverable conditions, so the
 * HTTP filter maps them to 500. They are typed (instead of plain `Error`)
 * purely for consistency — every throw in domain/application now flows
 * through the same DomainError pipeline, which the spec-compliance map can
 * point at without an asterisk.
 */
export class DomainInvariantError extends DomainError {
  readonly code = 'DOMAIN_INVARIANT_VIOLATION';
}
