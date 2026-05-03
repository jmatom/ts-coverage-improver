import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { RepositorySummaryDto } from '../dto/Dto';

export class ListRepositories {
  constructor(
    private readonly repos: RepositoryRepository,
    private readonly reports: CoverageReportRepository,
  ) {}

  async execute(): Promise<RepositorySummaryDto[]> {
    const repos = await this.repos.list();
    const summaries: RepositorySummaryDto[] = [];
    for (const r of repos) {
      const latest = await this.reports.findLatestByRepository(r.id);
      summaries.push({
        id: r.id.value,
        owner: r.owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
        forkOwner: r.forkOwner,
        lastAnalyzedAt: r.lastAnalyzedAt?.toISOString() ?? null,
        overallLinesPct: latest ? round2(latest.overallLinesPct()) : null,
        fileCount: latest?.files.length ?? 0,
        subpath: r.subpath,
        analysisStatus: r.analysisStatus,
        analysisError: r.analysisError,
        analysisStartedAt: r.analysisStartedAt?.toISOString() ?? null,
      });
    }
    return summaries;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
