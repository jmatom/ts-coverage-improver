import { randomUUID } from 'node:crypto';
import { DomainInvariantError } from '../errors/DomainError';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Value object: an ImprovementJob aggregate identifier (UUID v4 shape).
 *
 * Mirror of `RepositoryId` for the jobs aggregate — see that VO's docstring
 * for the boundary-wrapping rationale. Kept as a distinct type from
 * `RepositoryId` so the type system rejects swaps between the two.
 */
export class JobId {
  private constructor(public readonly value: string) {}

  static new(): JobId {
    return new JobId(randomUUID());
  }

  static of(raw: string): JobId {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
      throw new DomainInvariantError(`JobId must be a UUID; got '${raw}'`);
    }
    return new JobId(raw);
  }

  equals(other: JobId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
