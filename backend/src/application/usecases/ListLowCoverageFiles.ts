import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { CoverageAnalyzer } from '@domain/services/CoverageAnalyzer';
import { CoverageThreshold } from '@domain/coverage/CoverageThreshold';
import { FileCoverageDto } from '../dto/Dto';

export class ListLowCoverageFiles {
  constructor(private readonly reports: CoverageReportRepository) {}

  async execute(input: {
    repositoryId: string;
    threshold: CoverageThreshold;
  }): Promise<FileCoverageDto[]> {
    const latest = await this.reports.findLatestByRepository(input.repositoryId);
    if (!latest) return [];
    const low = CoverageAnalyzer.lowCoverageFiles(latest, input.threshold.value);
    return low.map((f) => ({
      path: f.path,
      linesPct: f.linesPct,
      branchesPct: f.branchesPct,
      functionsPct: f.functionsPct,
      uncoveredLines: [...f.uncoveredLines],
      hasExistingTest: f.hasExistingTest,
    }));
  }
}
