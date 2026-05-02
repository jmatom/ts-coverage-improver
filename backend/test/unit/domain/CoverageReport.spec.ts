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

describe('CoverageReport', () => {
  it('rejects empty repositoryId or commitSha', () => {
    expect(() =>
      CoverageReport.create({ repositoryId: '', commitSha: 'abc', files: [] }),
    ).toThrow();
    expect(() =>
      CoverageReport.create({ repositoryId: 'r', commitSha: '   ', files: [] }),
    ).toThrow();
  });

  it('overallLinesPct averages file lines%', () => {
    const report = CoverageReport.create({
      repositoryId: 'r',
      commitSha: 'sha1',
      files: [fc('a.ts', 50), fc('b.ts', 100)],
    });
    expect(report.overallLinesPct()).toBe(75);
  });

  it('overallLinesPct returns 0 for empty reports', () => {
    const report = CoverageReport.create({
      repositoryId: 'r',
      commitSha: 'sha',
      files: [],
    });
    expect(report.overallLinesPct()).toBe(0);
  });

  it('fileFor returns undefined for unknown paths', () => {
    const report = CoverageReport.create({
      repositoryId: 'r',
      commitSha: 'sha',
      files: [fc('a.ts', 50)],
    });
    expect(report.fileFor('a.ts')?.linesPct).toBe(50);
    expect(report.fileFor('z.ts')).toBeUndefined();
  });
});
