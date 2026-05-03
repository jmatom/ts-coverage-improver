import { DomainInvariantError, InvalidGitHubUrlError } from '../errors/DomainError';
import { Subpath } from './Subpath';
import { RepositoryId } from './RepositoryId';

export type AnalysisStatus = 'idle' | 'pending' | 'running' | 'failed';

export interface RepositoryProps {
  id: RepositoryId;
  owner: string;
  name: string;
  defaultBranch: string;
  forkOwner: string | null;
  lastAnalyzedAt: Date | null;
  /**
   * Subpath inside the cloned repo where this package's `package.json`
   * lives. Empty string = repo root (the common case). Examples: '',
   * 'backend', 'apps/web', 'packages/core'. Used by analyze + improve
   * to scope all package-level operations (install, tests, AI run,
   * file probes) to that subdirectory. Git operations stay at the repo
   * clone root.
   *
   * Invariants enforced at construction (see normalizeSubpath below):
   *   - never starts with '/' or contains '..' segments
   *   - leading/trailing slashes trimmed
   *   - whitespace trimmed
   */
  subpath: string;
  /**
   * Lifecycle of the most recent analyze-coverage request for this repo.
   * `idle` = no work in flight (and either never analyzed, or the last
   * analyze succeeded). `pending` = queued. `running` = worker is in the
   * clone/install/test phase. `failed` = last attempt failed; `analysisError`
   * has the reason. A successful analysis writes `lastAnalyzedAt` and
   * transitions back to `idle`.
   */
  analysisStatus: AnalysisStatus;
  analysisError: string | null;
  analysisStartedAt: Date | null;
  /**
   * How many times the repository's analysis lifecycle has been automatically
   * resurrected from a `running` state at process boot (i.e., the worker
   * died mid-analysis). Capped at 1 by the boot reconciler. Reset to 0
   * whenever the user manually re-requests analysis (each manual request
   * gets a fresh auto-retry budget).
   */
  analysisAutoRetryCount: number;
}

/**
 * Aggregate root: a GitHub repository tracked by the system.
 *
 * Invariant: owner/name are non-empty and case-preserved exactly as on GitHub
 * (URLs in fork-and-PR flows are case-sensitive).
 */
export class Repository {
  private constructor(private readonly props: RepositoryProps) {}

  static create(input: {
    owner: string;
    name: string;
    defaultBranch: string;
    subpath?: string;
  }): Repository {
    if (!input.owner.trim() || !input.name.trim()) {
      throw new DomainInvariantError('Repository.owner and Repository.name must be non-empty');
    }
    return new Repository({
      id: RepositoryId.new(),
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch || 'main',
      forkOwner: null,
      lastAnalyzedAt: null,
      // Subpath VO enforces the path-traversal guard centrally; we store
      // the validated `.value` string for persistence/path-join compat.
      subpath: Subpath.of(input.subpath ?? '').value,
      analysisStatus: 'idle',
      analysisError: null,
      analysisStartedAt: null,
      analysisAutoRetryCount: 0,
    });
  }

  static rehydrate(props: RepositoryProps): Repository {
    return new Repository({ ...props });
  }

  get id(): RepositoryId {
    return this.props.id;
  }
  get owner(): string {
    return this.props.owner;
  }
  get name(): string {
    return this.props.name;
  }
  get defaultBranch(): string {
    return this.props.defaultBranch;
  }
  get forkOwner(): string | null {
    return this.props.forkOwner;
  }
  get lastAnalyzedAt(): Date | null {
    return this.props.lastAnalyzedAt;
  }
  get subpath(): string {
    return this.props.subpath;
  }
  get analysisStatus(): AnalysisStatus {
    return this.props.analysisStatus;
  }
  get analysisError(): string | null {
    return this.props.analysisError;
  }
  get analysisStartedAt(): Date | null {
    return this.props.analysisStartedAt;
  }
  get analysisAutoRetryCount(): number {
    return this.props.analysisAutoRetryCount;
  }
  get isAnalyzing(): boolean {
    return this.props.analysisStatus === 'pending' || this.props.analysisStatus === 'running';
  }

  get fullName(): string {
    return `${this.props.owner}/${this.props.name}`;
  }
  get cloneUrl(): string {
    return `https://github.com/${this.fullName}.git`;
  }

  recordFork(forkOwner: string): void {
    if (!forkOwner.trim()) throw new DomainInvariantError('forkOwner must be non-empty');
    this.props.forkOwner = forkOwner;
  }

  markAnalyzed(at: Date = new Date()): void {
    this.props.lastAnalyzedAt = at;
    this.props.analysisStatus = 'idle';
    this.props.analysisError = null;
    this.props.analysisStartedAt = null;
  }

  /** Transition to `pending` (request received). Allowed from any non-running state. */
  markAnalysisRequested(): void {
    if (this.props.analysisStatus === 'running') {
      throw new DomainInvariantError(
        'Cannot request a new analysis while one is currently running for this repository',
      );
    }
    this.props.analysisStatus = 'pending';
    this.props.analysisError = null;
    this.props.analysisStartedAt = null;
    // Each manual request gets a fresh auto-retry budget. Without this, a
    // repo that crashed once would be stuck at count=1 forever and never
    // benefit from automatic crash recovery on a subsequent run.
    this.props.analysisAutoRetryCount = 0;
  }

  /** Transition to `running`. Worker calls this when it picks up a pending job. */
  markAnalysisRunning(at: Date = new Date()): void {
    if (this.props.analysisStatus !== 'pending') {
      throw new DomainInvariantError(
        `Cannot start analysis from status '${this.props.analysisStatus}'; expected 'pending'`,
      );
    }
    this.props.analysisStatus = 'running';
    this.props.analysisStartedAt = at;
  }

  /** Transition to `failed`, recording the reason. Worker calls this on exception. */
  markAnalysisFailed(error: string): void {
    this.props.analysisStatus = 'failed';
    this.props.analysisError = error;
  }

  toPlain(): RepositoryProps {
    return { ...this.props };
  }

  /**
   * Parse `https://github.com/<owner>/<name>` (with or without `.git`) into
   * `{ owner, name }`. Other forms are rejected.
   */
  static parseUrl(url: string): { owner: string; name: string } {
    const match = url
      .trim()
      .replace(/\.git$/, '')
      .match(/github\.com[/:]([^/]+)\/([^/]+)\/?$/);
    if (!match) {
      throw new InvalidGitHubUrlError(url);
    }
    return { owner: match[1], name: match[2] };
  }
}
