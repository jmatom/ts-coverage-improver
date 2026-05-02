import { FileCoverage } from '../coverage/FileCoverage';
import { SupportedTestFramework } from './AICliPort';

export interface CoverageRunInput {
  /** Workdir containing the cloned repo. */
  workdir: string;
}

export interface CoverageRunResult {
  framework: SupportedTestFramework;
  /** All file-level coverage records produced by the run. */
  files: FileCoverage[];
  /** Combined orchestrator + tool stdout/stderr for logging. */
  logs: string;
}

/**
 * Port for running a repo's test suite with coverage instrumentation,
 * detecting framework + package manager, and returning a parsed report.
 *
 * Honors the locked decision: orchestrator (not the AI) runs tests.
 */
export interface CoverageRunnerPort {
  run(input: CoverageRunInput): Promise<CoverageRunResult>;
}
