import { CoveragePercentage } from '../../../src/domain/coverage/CoveragePercentage';
import { DomainInvariantError } from '../../../src/domain/errors/DomainError';

describe('CoveragePercentage', () => {
  it('accepts the boundaries 0 and 100', () => {
    expect(CoveragePercentage.of(0).value).toBe(0);
    expect(CoveragePercentage.of(100).value).toBe(100);
  });

  it('accepts decimals in [0, 100]', () => {
    expect(CoveragePercentage.of(42.5).value).toBe(42.5);
    expect(CoveragePercentage.of(99.99).value).toBe(99.99);
  });

  it('rejects negatives', () => {
    expect(() => CoveragePercentage.of(-0.1)).toThrow(DomainInvariantError);
  });

  it('rejects values above 100', () => {
    expect(() => CoveragePercentage.of(100.01)).toThrow(DomainInvariantError);
  });

  it('rejects non-finite numbers (NaN, ±Infinity)', () => {
    expect(() => CoveragePercentage.of(Number.NaN)).toThrow(DomainInvariantError);
    expect(() => CoveragePercentage.of(Number.POSITIVE_INFINITY)).toThrow(DomainInvariantError);
    expect(() => CoveragePercentage.of(Number.NEGATIVE_INFINITY)).toThrow(DomainInvariantError);
  });

  describe('optional', () => {
    it('returns null for null input', () => {
      expect(CoveragePercentage.optional(null)).toBeNull();
    });

    it('returns a VO for valid numbers', () => {
      expect(CoveragePercentage.optional(50)?.value).toBe(50);
    });

    it('throws for invalid numbers (does not silently null them)', () => {
      expect(() => CoveragePercentage.optional(150)).toThrow(DomainInvariantError);
    });
  });

  it('isBelow respects the threshold', () => {
    expect(CoveragePercentage.of(79).isBelow(80)).toBe(true);
    expect(CoveragePercentage.of(80).isBelow(80)).toBe(false); // strict <
    expect(CoveragePercentage.of(81).isBelow(80)).toBe(false);
  });

  it('equals is structural', () => {
    expect(CoveragePercentage.of(42.5).equals(CoveragePercentage.of(42.5))).toBe(true);
    expect(CoveragePercentage.of(42.5).equals(CoveragePercentage.of(42.6))).toBe(false);
  });
});
