import { DomainInvariantError } from '../errors/DomainError';
import { randomUUID } from 'node:crypto';
import { ImprovementMode, JobStatus } from './JobStatus';

export interface ImprovementJobProps {
  id: string;
  repositoryId: string;
  targetFilePath: string;
  status: JobStatus;
  mode: ImprovementMode | null;
  prUrl: string | null;
  coverageBefore: number | null;
  coverageAfter: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Aggregate: an improvement attempt for a single file in a repository.
 *
 * State machine:
 *   pending → running → succeeded | failed
 *   pending → failed (e.g., reconciled after process restart)
 *
 * All transitions are guarded; illegal transitions throw, which protects
 * us from buggy callers and makes the state model the single source of truth.
 */
export class ImprovementJob {
  private constructor(private readonly props: ImprovementJobProps) {}

  static create(input: { repositoryId: string; targetFilePath: string }): ImprovementJob {
    if (!input.repositoryId.trim()) throw new DomainInvariantError('repositoryId must be non-empty');
    if (!input.targetFilePath.trim()) throw new DomainInvariantError('targetFilePath must be non-empty');
    return new ImprovementJob({
      id: randomUUID(),
      repositoryId: input.repositoryId,
      targetFilePath: input.targetFilePath,
      status: 'pending',
      mode: null,
      prUrl: null,
      coverageBefore: null,
      coverageAfter: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    });
  }

  static rehydrate(props: ImprovementJobProps): ImprovementJob {
    return new ImprovementJob({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get repositoryId(): string {
    return this.props.repositoryId;
  }
  get targetFilePath(): string {
    return this.props.targetFilePath;
  }
  get status(): JobStatus {
    return this.props.status;
  }
  get mode(): ImprovementMode | null {
    return this.props.mode;
  }
  get prUrl(): string | null {
    return this.props.prUrl;
  }
  get coverageBefore(): number | null {
    return this.props.coverageBefore;
  }
  get coverageAfter(): number | null {
    return this.props.coverageAfter;
  }
  get error(): string | null {
    return this.props.error;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get startedAt(): Date | null {
    return this.props.startedAt;
  }
  get completedAt(): Date | null {
    return this.props.completedAt;
  }

  isTerminal(): boolean {
    return this.props.status === 'succeeded' || this.props.status === 'failed';
  }

  start(coverageBefore: number): void {
    if (this.props.status !== 'pending') {
      throw new DomainInvariantError(`Cannot start job in status '${this.props.status}'`);
    }
    this.props.status = 'running';
    this.props.coverageBefore = coverageBefore;
    this.props.startedAt = new Date();
  }

  setMode(mode: ImprovementMode): void {
    if (this.props.status !== 'running') {
      throw new DomainInvariantError(`Cannot set mode in status '${this.props.status}'`);
    }
    this.props.mode = mode;
  }

  succeed(input: { prUrl: string; coverageAfter: number; mode: ImprovementMode }): void {
    if (this.props.status !== 'running') {
      throw new DomainInvariantError(`Cannot succeed job in status '${this.props.status}'`);
    }
    if (!input.prUrl.trim()) throw new DomainInvariantError('prUrl must be non-empty on success');
    this.props.status = 'succeeded';
    this.props.prUrl = input.prUrl;
    this.props.coverageAfter = input.coverageAfter;
    this.props.mode = input.mode;
    this.props.completedAt = new Date();
  }

  fail(reason: string): void {
    if (this.props.status === 'succeeded' || this.props.status === 'failed') {
      throw new DomainInvariantError(`Cannot fail job in terminal status '${this.props.status}'`);
    }
    this.props.status = 'failed';
    this.props.error = reason;
    this.props.completedAt = new Date();
  }

  toPlain(): ImprovementJobProps {
    return { ...this.props };
  }
}
