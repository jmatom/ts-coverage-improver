import { randomUUID } from 'node:crypto';
import { InvalidRepositoryIdError } from '../errors/DomainError';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Value object: a Repository aggregate identifier (UUID v4 shape).
 *
 * Every controller wraps incoming `:id` path params as a `RepositoryId` at the
 * boundary; ports, use cases, and entities then traffic in the typed VO. The
 * SQLite layer unwraps `.value` for SQL bindings and re-wraps when rehydrating.
 *
 * Distinct from `JobId` even though both are UUIDs — keeping them as separate
 * VOs lets the type system reject accidental swaps (the kind of mistake that
 * would otherwise sail through code review and only surface as a 404 in prod).
 *
 * Immutable. `.equals()` is structural. `.new()` mints a fresh ID for newly
 * created aggregates; `.of(string)` parses an existing ID (rehydration,
 * controller boundary) and validates UUID shape.
 */
export class RepositoryId {
  private constructor(public readonly value: string) {}

  static new(): RepositoryId {
    return new RepositoryId(randomUUID());
  }

  static of(raw: string): RepositoryId {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
      throw new InvalidRepositoryIdError(raw);
    }
    return new RepositoryId(raw);
  }

  equals(other: RepositoryId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
