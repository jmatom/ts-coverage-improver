import { DomainInvariantError } from '../errors/DomainError';

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type ImprovementMode = 'append' | 'sibling';

/**
 * Value object: an improvement job's lifecycle status, with the legal
 * transition table baked in.
 *
 * Replaces scattered `if (status !== 'pending') throw` checks in the
 * `ImprovementJob` aggregate — the VO owns the rule "what can become
 * what," so callers just request a transition and either get a new
 * `JobStatusValue` or a `DomainInvariantError`. The aggregate stays
 * focused on *what to update* alongside the transition (timestamps,
 * coverage numbers, error reason); the transition *itself* is here.
 *
 * Immutable. `equals()` is structural. The raw string is exposed via
 * `.value` for serialization (DB rows, DTOs).
 */
export class JobStatusValue {
  private constructor(public readonly value: JobStatus) {}

  static of(value: JobStatus): JobStatusValue {
    if (!(JOB_STATUSES as readonly string[]).includes(value)) {
      throw new DomainInvariantError(`Unknown JobStatus '${value}'`);
    }
    return new JobStatusValue(value);
  }

  static pending(): JobStatusValue {
    return new JobStatusValue('pending');
  }

  isTerminal(): boolean {
    return this.value === 'succeeded' || this.value === 'failed';
  }

  equals(other: JobStatusValue): boolean {
    return this.value === other.value;
  }

  /**
   * Return a new VO at `target` if the transition is legal, else throw.
   * Single source of truth for the lifecycle:
   *   pending   → running | failed
   *   running   → succeeded | failed
   *   succeeded → (none — terminal)
   *   failed    → (none — terminal)
   */
  transitionTo(target: JobStatus): JobStatusValue {
    if (!LEGAL_TRANSITIONS[this.value].includes(target)) {
      throw new DomainInvariantError(
        `Illegal job status transition: '${this.value}' → '${target}'`,
      );
    }
    return JobStatusValue.of(target);
  }
}

const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ['running', 'failed'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};
