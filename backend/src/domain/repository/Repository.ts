import { randomUUID } from 'node:crypto';
import { DomainInvariantError, InvalidGitHubUrlError } from '../errors/DomainError';

export interface RepositoryProps {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  forkOwner: string | null;
  lastAnalyzedAt: Date | null;
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
