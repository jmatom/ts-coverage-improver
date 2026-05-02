import { randomUUID } from 'node:crypto';
import { DomainInvariantError, InvalidGitHubUrlError } from '../errors/DomainError';

export type AnalysisStatus = 'idle' | 'pending' | 'running' | 'failed';

export interface RepositoryProps {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  forkOwner: string | null;
  lastAnalyzedAt: Date | null;
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
  }): Repository {
    if (!input.owner.trim() || !input.name.trim()) {
      throw new DomainInvariantError('Repository.owner and Repository.name must be non-empty');
    }
    return new Repository({
      id: randomUUID(),
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch || 'main',
      forkOwner: null,
      lastAnalyzedAt: null,
      analysisStatus: 'idle',
      analysisError: null,
      analysisStartedAt: null,
    });
  }

  static rehydrate(props: RepositoryProps): Repository {
    return new Repository({ ...props });
  }

  get id(): string {
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
  get analysisStatus(): AnalysisStatus {
    return this.props.analysisStatus;
  }
  get analysisError(): string | null {
    return this.props.analysisError;
  }
  get analysisStartedAt(): Date | null {
    return this.props.analysisStartedAt;
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
