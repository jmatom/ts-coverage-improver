import { CoverageReport } from '../coverage/CoverageReport';

export interface CoverageReportRepository {
  save(report: CoverageReport): Promise<void>;
  findLatestByRepository(repositoryId: string): Promise<CoverageReport | null>;
}
