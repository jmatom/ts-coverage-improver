import { CoverageThreshold } from '../../../src/domain/coverage/CoverageThreshold';
import { InvalidCoverageThresholdError } from '../../../src/domain/errors/DomainError';

describe('CoverageThreshold', () => {
  describe('of', () => {
    it('accepts boundaries 0 and 100', () => {
      expect(CoverageThreshold.of(0).value).toBe(0);
      expect(CoverageThreshold.of(100).value).toBe(100);
    });

    it('accepts decimals in range', () => {
      expect(CoverageThreshold.of(80).value).toBe(80);
      expect(CoverageThreshold.of(42.5).value).toBe(42.5);
    });

    it('rejects negatives', () => {
      expect(() => CoverageThreshold.of(-0.1)).toThrow(InvalidCoverageThresholdError);
    });

    it('rejects > 100', () => {
      expect(() => CoverageThreshold.of(100.01)).toThrow(InvalidCoverageThresholdError);
    });

    it('rejects NaN/Infinity', () => {
      expect(() => CoverageThreshold.of(Number.NaN)).toThrow(InvalidCoverageThresholdError);
      expect(() => CoverageThreshold.of(Number.POSITIVE_INFINITY)).toThrow(InvalidCoverageThresholdError);
    });
  });

  describe('fromInput', () => {
    it('returns the default when input is undefined', () => {
      expect(CoverageThreshold.fromInput(undefined, 80).value).toBe(80);
    });

    it('returns the default when input is null', () => {
      expect(CoverageThreshold.fromInput(null, 80).value).toBe(80);
    });

    it('returns the default when input is empty string', () => {
      expect(CoverageThreshold.fromInput('', 80).value).toBe(80);
    });

    it('parses numeric strings (HTTP query params)', () => {
      expect(CoverageThreshold.fromInput('50', 80).value).toBe(50);
      expect(CoverageThreshold.fromInput('42.5', 80).value).toBe(42.5);
    });

    it('passes through numeric inputs unchanged', () => {
      expect(CoverageThreshold.fromInput(60, 80).value).toBe(60);
    });

    it('throws on unparseable string input', () => {
      expect(() => CoverageThreshold.fromInput('weird', 80)).toThrow(InvalidCoverageThresholdError);
    });

    it('throws on out-of-range numeric input', () => {
      expect(() => CoverageThreshold.fromInput('150', 80)).toThrow(InvalidCoverageThresholdError);
    });
  });

  it('equals is structural', () => {
    expect(CoverageThreshold.of(80).equals(CoverageThreshold.of(80))).toBe(true);
    expect(CoverageThreshold.of(80).equals(CoverageThreshold.of(50))).toBe(false);
  });
});
