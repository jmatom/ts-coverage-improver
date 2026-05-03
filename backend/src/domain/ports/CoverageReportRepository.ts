import { CoverageReport } from '../coverage/CoverageReport';
import { RepositoryId } from '../repository/RepositoryId';

export interface CoverageReportRepository {
  save(report: CoverageReport): Promise<void>;
  findLatestByRepository(repositoryId: RepositoryId): Promise<CoverageReport | null>;
}
