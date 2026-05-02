import { DomainInvariantError } from '../errors/DomainError';
export interface FileCoverageProps {
  path: string;
  linesPct: number;
  branchesPct: number | null;
  functionsPct: number | null;
  statementsPct: number | null;
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
    FileCoverage.assertPct('linesPct', props.linesPct);
    FileCoverage.assertPctOrNull('branchesPct', props.branchesPct);
    FileCoverage.assertPctOrNull('functionsPct', props.functionsPct);
    FileCoverage.assertPctOrNull('statementsPct', props.statementsPct);
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

  private static assertPct(label: string, value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new DomainInvariantError(`FileCoverage.${label} must be a finite number in [0, 100]; got ${value}`);
    }
  }
  private static assertPctOrNull(label: string, value: number | null): void {
    if (value === null) return;
    FileCoverage.assertPct(label, value);
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
  get statementsPct(): number | null {
    return this.props.statementsPct;
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
