import { FileCoverage } from '../../../src/domain/coverage/FileCoverage';

describe('FileCoverage', () => {
  const baseProps = {
    path: 'src/foo.ts',
    linesPct: 50,
    branchesPct: 40,
    functionsPct: 60,
    uncoveredLines: [3, 1, 2],
  };

  it('sorts uncovered lines ascending on creation', () => {
    const fc = FileCoverage.create(baseProps);
    expect(fc.uncoveredLines).toEqual([1, 2, 3]);
  });

  it('rejects non-finite or out-of-range pct values', () => {
    expect(() => FileCoverage.create({ ...baseProps, linesPct: -1 })).toThrow();
    expect(() => FileCoverage.create({ ...baseProps, linesPct: 100.0001 })).toThrow();
    expect(() => FileCoverage.create({ ...baseProps, linesPct: NaN })).toThrow();
  });

  it('accepts null for optional metrics', () => {
    const fc = FileCoverage.create({
      ...baseProps,
      branchesPct: null,
      functionsPct: null,
    });
    expect(fc.branchesPct).toBeNull();
  });

  it('rejects empty path', () => {
    expect(() => FileCoverage.create({ ...baseProps, path: '   ' })).toThrow();
  });

  it('isBelowThreshold compares strictly', () => {
    const fc = FileCoverage.create({ ...baseProps, linesPct: 80 });
    expect(fc.isBelowThreshold(80)).toBe(false);
    expect(fc.isBelowThreshold(81)).toBe(true);
  });
});
