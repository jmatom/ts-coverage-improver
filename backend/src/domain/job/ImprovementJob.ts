import { DomainInvariantError } from '../errors/DomainError';
import { ImprovementMode, JobStatus, JobStatusValue } from './JobStatus';
import { JobId } from './JobId';
import { RepositoryId } from '../repository/RepositoryId';

export interface ImprovementJobProps {
  id: JobId;
  repositoryId: RepositoryId;
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
  /**
   * How many times this row has been automatically resurrected from a
   * `running` state at process boot (i.e., the worker died mid-execution).
   * Capped at 1 by the boot reconciler so a poison job that always crashes
   * the backend can't boot-loop the system.
   */
  autoRetryCount: number;
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

  static create(input: { repositoryId: RepositoryId; targetFilePath: string }): ImprovementJob {
    if (!input.targetFilePath.trim()) throw new DomainInvariantError('targetFilePath must be non-empty');
    return new ImprovementJob({
      id: JobId.new(),
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
      autoRetryCount: 0,
    });
  }

  static rehydrate(props: ImprovementJobProps): ImprovementJob {
    return new ImprovementJob({ ...props });
  }

  get id(): JobId {
    return this.props.id;
  }
  get repositoryId(): RepositoryId {
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
  get autoRetryCount(): number {
    return this.props.autoRetryCount;
  }

  /**
   * Read the current status as a value object. Internal helper —
   * `props.status` stays a string for persistence/DTO compatibility, but
   * every mutation routes through the VO so the transition table is the
   * single source of truth.
   */
  private currentStatus(): JobStatusValue {
    return JobStatusValue.of(this.props.status);
  }

  isTerminal(): boolean {
    return this.currentStatus().isTerminal();
  }

  start(coverageBefore: number): void {
    this.props.status = this.currentStatus().transitionTo('running').value;
    this.props.coverageBefore = coverageBefore;
    this.props.startedAt = new Date();
  }

  setMode(mode: ImprovementMode): void {
    // No transition — just a guard. setMode mutates `mode` while staying
    // in `running`, so it can't go through transitionTo (which forbids
    // self-loops). Cheapest correct check.
    if (this.props.status !== 'running') {
      throw new DomainInvariantError(`Cannot set mode in status '${this.props.status}'`);
    }
    this.props.mode = mode;
  }

  succeed(input: { prUrl: string; coverageAfter: number; mode: ImprovementMode }): void {
    if (!input.prUrl.trim()) throw new DomainInvariantError('prUrl must be non-empty on success');
    this.props.status = this.currentStatus().transitionTo('succeeded').value;
    this.props.prUrl = input.prUrl;
    this.props.coverageAfter = input.coverageAfter;
    this.props.mode = input.mode;
    this.props.completedAt = new Date();
  }

  fail(reason: string): void {
    this.props.status = this.currentStatus().transitionTo('failed').value;
    this.props.error = reason;
    this.props.completedAt = new Date();
  }

  toPlain(): ImprovementJobProps {
    return { ...this.props };
  }
}
