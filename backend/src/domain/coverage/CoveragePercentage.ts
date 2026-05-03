import { DomainInvariantError } from '../errors/DomainError';

/**
 * Value object: a coverage percentage in the closed range [0, 100].
 *
 * Replaces the inline `assertPct` checks scattered through `FileCoverage`
 * (one per metric × create vs validate). Centralizes the invariant — any
 * code holding a `CoveragePercentage` knows it has a valid percentage,
 * not a "trust me" raw `number`.
 *
 * Immutable. `equals()` is structural. `.value` exposes the raw `number`
 * for serialization (DB rows, lcov payloads, comparisons).
 *
 * Why a class wrapper for a single number: the validation only fires if
 * a `CoveragePercentage` is ever constructed, which is the canonical
 * "construct once, trust forever" pattern. Without it, every consumer
 * has to either re-validate or assume the producer did. With it, the
 * type IS the proof.
 */
export class CoveragePercentage {
  private constructor(public readonly value: number) {}

  static of(value: number): CoveragePercentage {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new DomainInvariantError(
        `CoveragePercentage must be a finite number in [0, 100]; got ${value}`,
      );
    }
    return new CoveragePercentage(value);
  }

  /**
   * Construct from a `number | null`. Returns `null` for null input,
   * VO for valid numbers, throws for invalid numbers. Useful for
   * "this metric may not be present in the lcov source" call sites.
   */
  static optional(value: number | null): CoveragePercentage | null {
    return value === null ? null : CoveragePercentage.of(value);
  }

  isBelow(threshold: number): boolean {
    return this.value < threshold;
  }

  equals(other: CoveragePercentage): boolean {
    return this.value === other.value;
  }
}
