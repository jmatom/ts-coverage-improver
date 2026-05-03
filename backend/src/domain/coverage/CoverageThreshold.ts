import { InvalidCoverageThresholdError } from '../errors/DomainError';

/**
 * Value object: a coverage threshold percentage in the closed range [0, 100].
 *
 * The user-supplied "show me files below X%" filter. Distinct from
 * `CoveragePercentage` (which is an *observed* coverage value) — semantically
 * a threshold and a measurement aren't the same thing even though they share
 * the same range. Keeping them as separate VOs prevents accidentally passing
 * one where the other is expected (the type system rejects the swap).
 *
 * Constructed at the controller boundary from raw query strings; flowed
 * through the use case as a typed value. Validation lives here so every
 * caller is automatically protected — no inline `if (t < 0 || t > 100)`
 * scattered across controllers / use cases.
 *
 * Immutable. `equals()` is structural. `.value` exposes the raw `number`
 * for downstream use (DB queries, comparisons against `CoveragePercentage`
 * via its `isBelow()` method).
 */
export class CoverageThreshold {
  private constructor(public readonly value: number) {}

  static of(value: number): CoverageThreshold {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new InvalidCoverageThresholdError(value);
    }
    return new CoverageThreshold(value);
  }

  /**
   * Construct from a raw user input where the source might be a string
   * (HTTP query param), a number (programmatic), or undefined (use the
   * provided default). Throws on invalid numeric input.
   */
  static fromInput(raw: unknown, defaultValue: number): CoverageThreshold {
    if (raw === undefined || raw === null || raw === '') {
      return CoverageThreshold.of(defaultValue);
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    return CoverageThreshold.of(n);
  }

  equals(other: CoverageThreshold): boolean {
    return this.value === other.value;
  }
}
