import { ListLowCoverageFiles } from './ListLowCoverageFiles';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { CoverageReport } from '@domain/coverage/CoverageReport';
import { FileCoverage } from '@domain/coverage/FileCoverage';

function makeFile(path: string, linesPct: number): FileCoverage {
  return FileCoverage.create({
    path,
    linesPct,
    branchesPct: 50,
    functionsPct: 75,
    statementsPct: null,
    uncoveredLines: [10, 20],
    hasExistingTest: false,
  });
}

function makeReport(files: FileCoverage[]): CoverageReport {
  return CoverageReport.create({
    repositoryId: 'repo-1',
    commitSha: 'abc123',
    files,
  });
}

function makeRepo(overrides: Partial<CoverageReportRepository> = {}): CoverageReportRepository {
  return {
    save: jest.fn(),
    findLatestByRepository: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('ListLowCoverageFiles', () => {
  it('returns an empty array when no report exists for the repository', async () => {
    const repo = makeRepo({ findLatestByRepository: jest.fn().mockResolvedValue(null) });
    const useCase = new ListLowCoverageFiles(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1' });

    expect(result).toEqual([]);
  });

  it('returns only files below the default threshold (80)', async () => {
    const report = makeReport([makeFile('src/low.ts', 60), makeFile('src/high.ts', 90)]);
    const repo = makeRepo({ findLatestByRepository: jest.fn().mockResolvedValue(report) });
    const useCase = new ListLowCoverageFiles(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1' });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/low.ts');
  });

  it('maps FileCoverage domain objects to FileCoverageDto shape', async () => {
    const report = makeReport([makeFile('src/foo.ts', 50)]);
    const repo = makeRepo({ findLatestByRepository: jest.fn().mockResolvedValue(report) });
    const useCase = new ListLowCoverageFiles(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1' });

    expect(result[0]).toEqual({
      path: 'src/foo.ts',
      linesPct: 50,
      branchesPct: 50,
      functionsPct: 75,
      uncoveredLines: [10, 20],
      hasExistingTest: false,
    });
  });

  it('respects a custom threshold passed in the input', async () => {
    const report = makeReport([makeFile('src/a.ts', 70), makeFile('src/b.ts', 50)]);
    const repo = makeRepo({ findLatestByRepository: jest.fn().mockResolvedValue(report) });
    const useCase = new ListLowCoverageFiles(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1', threshold: 60 });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/b.ts');
  });

  it('returns an empty array when all files are above the threshold', async () => {
    const report = makeReport([makeFile('src/a.ts', 95), makeFile('src/b.ts', 100)]);
    const repo = makeRepo({ findLatestByRepository: jest.fn().mockResolvedValue(report) });
    const useCase = new ListLowCoverageFiles(repo);

    const result = await useCase.execute({ repositoryId: 'repo-1' });

    expect(result).toEqual([]);
  });
});
