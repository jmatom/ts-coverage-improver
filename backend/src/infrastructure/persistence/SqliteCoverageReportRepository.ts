import { DatabaseSync } from 'node:sqlite';
import { CoverageReport } from '@domain/coverage/CoverageReport';
import { FileCoverage } from '@domain/coverage/FileCoverage';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';

interface ReportRow {
  id: string;
  repository_id: string;
  commit_sha: string;
  generated_at: string;
}

interface FileRow {
  path: string;
  lines_pct: number;
  branches_pct: number | null;
  functions_pct: number | null;
  uncovered_lines: string;
  has_existing_test: number | null;
}

export class SqliteCoverageReportRepository implements CoverageReportRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(report: CoverageReport): Promise<void> {
    const insertReport = this.db.prepare(
      `INSERT INTO coverage_reports (id, repository_id, commit_sha, generated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const insertFile = this.db.prepare(
      `INSERT INTO file_coverages
         (report_id, path, lines_pct, branches_pct, functions_pct, uncovered_lines, has_existing_test)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(report_id, path) DO UPDATE SET
         lines_pct = excluded.lines_pct,
         branches_pct = excluded.branches_pct,
         functions_pct = excluded.functions_pct,
         uncovered_lines = excluded.uncovered_lines,
         has_existing_test = excluded.has_existing_test`,
    );

    this.db.exec('BEGIN');
    try {
      insertReport.run(
        report.id,
        report.repositoryId,
        report.commitSha,
        report.generatedAt.toISOString(),
      );
      for (const f of report.files) {
        insertFile.run(
          report.id,
          f.path,
          f.linesPct,
          f.branchesPct,
          f.functionsPct,
          JSON.stringify([...f.uncoveredLines]),
          f.hasExistingTest === null ? null : f.hasExistingTest ? 1 : 0,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async findLatestByRepository(repositoryId: string): Promise<CoverageReport | null> {
    const reportRow = this.db
      .prepare(
        `SELECT * FROM coverage_reports
          WHERE repository_id = ?
          ORDER BY generated_at DESC
          LIMIT 1`,
      )
      .get(repositoryId) as unknown as ReportRow | undefined;
    if (!reportRow) return null;

    const fileRows = this.db
      .prepare('SELECT * FROM file_coverages WHERE report_id = ?')
      .all(reportRow.id) as unknown as FileRow[];

    const files = fileRows.map((r) =>
      FileCoverage.create({
        path: r.path,
        linesPct: r.lines_pct,
        branchesPct: r.branches_pct,
        functionsPct: r.functions_pct,
        uncoveredLines: JSON.parse(r.uncovered_lines) as number[],
        hasExistingTest:
          r.has_existing_test === null ? null : r.has_existing_test === 1,
      }),
    );

    return CoverageReport.rehydrate({
      id: reportRow.id,
      repositoryId: reportRow.repository_id,
      commitSha: reportRow.commit_sha,
      generatedAt: new Date(reportRow.generated_at),
      files,
    });
  }
}
