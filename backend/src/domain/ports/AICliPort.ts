import { ImprovementMode } from '../job/JobStatus';

export type SupportedTestFramework = 'jest' | 'vitest' | 'mocha';

export interface GenerateTestInput {
  /** Absolute host path to the workdir; the AI sees it as `/workspace` inside the sandbox. */
  workdir: string;
  /** Path to the source file under test, relative to the workdir. */
  sourceFilePath: string;
  /** Path to the existing test file (if any) the adapter should append to. */
  existingTestFilePath: string | null;
  /**
   * Path the AI must write its test code to. Decided by the orchestrator:
   *   - append mode: same as `existingTestFilePath`
   *   - sibling mode (no test ever existed): idiomatic `<basename>.test.ts`
   *   - sibling mode (fallback after failed append): `<basename>.generated.test.ts`
   * Single source of truth — the prompt builder renders this name; the
   * orchestrator validates the same path post-AI.
   */
  targetTestFilePath: string;
  /** Line numbers (1-based) currently uncovered, from the latest lcov scan. */
  uncoveredLines: readonly number[];
  /** Test framework detected from package.json (drives import & assertion style). */
  framework: SupportedTestFramework;
  /** Whether the adapter should append to an existing file or create a new sibling. */
  targetMode: ImprovementMode;
  /** Optional sample test from the same repo, used for few-shot style matching. */
  styleExample: string | null;
  /** Pre-validated env vars to forward to the sandbox (subset of process.env). */
  env: Record<string, string>;
  /**
   * Free-text feedback from a previous attempt's validator (test failure log,
   * AST violation list, coverage-delta failure). Injected into the prompt on retry.
   */
  retryFeedback?: string;
}

export interface GenerateTestOutput {
  /** Files written or modified by the AI, paths relative to the workdir. */
  writtenFiles: string[];
  /** Adapter logs (CLI stdout/stderr / status messages) for the job log. */
  logs: string;
}

/**
 * Port for AI CLI integration. The "documented seam" satisfying the spec line
 * "via any AI CLI" — adapters live in infrastructure/ai/.
 *
 * Each adapter declares its required env vars statically so the orchestrator
 * can validate presence at boot and inject them into the sandbox container at
 * job time. Adapters never read process.env directly.
 */
export interface AICliPort {
  /** Stable identifier for this adapter, e.g. 'claude', 'gemini'. */
  readonly id: string;
  /** Env var names the adapter requires the sandbox to inject. */
  readonly requiredEnv: readonly string[];
  /** Env var names the adapter may use if present. */
  readonly optionalEnv: readonly string[];

  generateTest(input: GenerateTestInput): Promise<GenerateTestOutput>;
}
