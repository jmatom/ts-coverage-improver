import { DomainInvariantError } from '../errors/DomainError';
import { CoveragePercentage } from './CoveragePercentage';
export interface FileCoverageProps {
  path: string;
  linesPct: number;
  branchesPct: number | null;
  functionsPct: number | null;
  uncoveredLines: readonly number[];
  /**
   * Whether a sibling test file (e.g. `<basename>.test.ts`, `<basename>.spec.ts`,
   * `__tests__/<basename>.test.ts`, etc.) was observed at analysis time.
   * `null` = unknown (e.g., LcovParser cannot determine this on its own; the
   * AnalyzeRepositoryCoverage use case fills it in by probing the workdir).
   */
  hasExistingTest: boolean | null;
}

/**
 * Value object: per-file coverage. Equality is by `path`, but the value is
 * meaningful only in the context of its enclosing CoverageReport.
 *
 * Percentages are 0..100 inclusive. `null` means "this metric is not present
 * in the lcov source" (e.g., projects without branch coverage configured).
 */
export class FileCoverage {
  private constructor(private readonly props: FileCoverageProps) {}

  static create(props: Omit<FileCoverageProps, 'hasExistingTest'> & { hasExistingTest?: boolean | null }): FileCoverage {
    if (!props.path.trim()) throw new DomainInvariantError('FileCoverage.path must be non-empty');
    // Construct the VOs purely for validation — they throw on out-of-range
    // values. Internal storage stays as `number | null` for serialization
    // (SQLite columns, lcov payloads). The VO is the proof of validity.
    CoveragePercentage.of(props.linesPct);
    CoveragePercentage.optional(props.branchesPct);
    CoveragePercentage.optional(props.functionsPct);
    return new FileCoverage({
      ...props,
      hasExistingTest: props.hasExistingTest ?? null,
      uncoveredLines: [...props.uncoveredLines].sort((a, b) => a - b),
    });
  }

  /** Return a copy with `hasExistingTest` overridden. Used by analyzers that
   *  enrich lcov-derived data with workdir-only signals. */
  withHasExistingTest(value: boolean): FileCoverage {
    return new FileCoverage({ ...this.props, hasExistingTest: value });
  }

  get path(): string {
    return this.props.path;
  }
  get linesPct(): number {
    return this.props.linesPct;
  }
  get branchesPct(): number | null {
    return this.props.branchesPct;
  }
  get functionsPct(): number | null {
    return this.props.functionsPct;
  }
  get uncoveredLines(): readonly number[] {
    return this.props.uncoveredLines;
  }
  get hasExistingTest(): boolean | null {
    return this.props.hasExistingTest;
  }

  isBelowThreshold(threshold: number): boolean {
    return this.linesPct < threshold;
  }

  toPlain(): FileCoverageProps {
    return { ...this.props, uncoveredLines: [...this.props.uncoveredLines] };
  }
}
