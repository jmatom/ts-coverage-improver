import { DomainInvariantError } from '../errors/DomainError';
import { randomUUID } from 'node:crypto';
import { FileCoverage } from './FileCoverage';
import { RepositoryId } from '../repository/RepositoryId';

export interface CoverageReportProps {
  id: string;
  repositoryId: RepositoryId;
  commitSha: string;
  generatedAt: Date;
  files: FileCoverage[];
}

/**
 * Aggregate: a single coverage scan for a repository at a specific commit.
 *
 * Reports are immutable after creation; a new scan produces a new report.
 */
export class CoverageReport {
  private constructor(private readonly props: CoverageReportProps) {}

  static create(input: {
    repositoryId: RepositoryId;
    commitSha: string;
    files: FileCoverage[];
    generatedAt?: Date;
  }): CoverageReport {
    if (!input.commitSha.trim()) throw new DomainInvariantError('commitSha must be non-empty');
    return new CoverageReport({
      id: randomUUID(),
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      generatedAt: input.generatedAt ?? new Date(),
      files: [...input.files],
    });
  }

  static rehydrate(props: CoverageReportProps): CoverageReport {
    return new CoverageReport({ ...props, files: [...props.files] });
  }

  get id(): string {
    return this.props.id;
  }
  get repositoryId(): RepositoryId {
    return this.props.repositoryId;
  }
  get commitSha(): string {
    return this.props.commitSha;
  }
  get generatedAt(): Date {
    return this.props.generatedAt;
  }
  get files(): readonly FileCoverage[] {
    return this.props.files;
  }

  /** Average lines% across all files, weighted equally. Returns 0 for empty reports. */
  overallLinesPct(): number {
    if (this.props.files.length === 0) return 0;
    const sum = this.props.files.reduce((acc, f) => acc + f.linesPct, 0);
    return sum / this.props.files.length;
  }

  fileFor(path: string): FileCoverage | undefined {
    return this.props.files.find((f) => f.path === path);
  }
}
