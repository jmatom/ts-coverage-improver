import { CoverageAnalyzer } from '../../../src/domain/services/CoverageAnalyzer';
import { CoverageReport } from '../../../src/domain/coverage/CoverageReport';
import { FileCoverage } from '../../../src/domain/coverage/FileCoverage';

const fc = (path: string, linesPct: number) =>
  FileCoverage.create({
    path,
    linesPct,
    branchesPct: null,
    functionsPct: null,
    statementsPct: null,
    uncoveredLines: [],
  });

describe('CoverageAnalyzer', () => {
  const report = CoverageReport.create({
    repositoryId: 'r',
    commitSha: 's',
    files: [fc('a.ts', 95), fc('b.ts', 50), fc('c.ts', 79.999), fc('d.ts', 80)],
  });

  it('returns files strictly below threshold, ascending', () => {
    const low = CoverageAnalyzer.lowCoverageFiles(report, 80);
    expect(low.map((f) => f.path)).toEqual(['b.ts', 'c.ts']);
  });

  it('uses default threshold of 80', () => {
    const low = CoverageAnalyzer.lowCoverageFiles(report);
    expect(low.map((f) => f.path)).toEqual(['b.ts', 'c.ts']);
  });

  it('returns empty when all files at or above threshold', () => {
    const r = CoverageReport.create({
      repositoryId: 'r',
      commitSha: 's',
      files: [fc('a.ts', 90), fc('b.ts', 100)],
    });
    expect(CoverageAnalyzer.lowCoverageFiles(r, 80)).toEqual([]);
  });

  it('rejects out-of-range thresholds', () => {
    expect(() => CoverageAnalyzer.lowCoverageFiles(report, -1)).toThrow();
    expect(() => CoverageAnalyzer.lowCoverageFiles(report, 101)).toThrow();
  });
});
