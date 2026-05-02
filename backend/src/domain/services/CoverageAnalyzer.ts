import { DomainInvariantError } from '../errors/DomainError';
import { CoverageReport } from '../coverage/CoverageReport';
import { FileCoverage } from '../coverage/FileCoverage';

/**
 * Domain service: identify and rank low-coverage files within a report.
 *
 * Pure function over the aggregate; no I/O, no framework deps. Lives in the
 * domain layer because "what counts as low coverage" is a business rule.
 */
export class CoverageAnalyzer {
  static readonly DEFAULT_THRESHOLD = 80;

  /**
   * Files strictly below the threshold, sorted ascending by linesPct
   * (lowest coverage first — those are the most valuable to improve).
   */
  static lowCoverageFiles(
    report: CoverageReport,
    threshold: number = CoverageAnalyzer.DEFAULT_THRESHOLD,
  ): readonly FileCoverage[] {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new DomainInvariantError(`Threshold must be in [0, 100]; got ${threshold}`);
    }
    return [...report.files]
      .filter((f) => f.isBelowThreshold(threshold))
      .sort((a, b) => a.linesPct - b.linesPct);
  }
}
