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
 * Port for "given a source file + uncovered lines + framework, produce test
 * code." Implementations live in `infrastructure/ai/` — today: Claude Code
 * via headless CLI in a sandbox; the example sketch shows Gemini CLI
 * following the same shape. Other deliveries (in-process LLM SDK, hosted
 * API, deterministic codegen) would also fit if they implement this method.
 *
 * The `requiredEnv` / `optionalEnv` fields are a CLI-shaped concession: they
 * exist so the orchestrator can validate presence of the adapter's secrets
 * at boot and inject the right subset into the per-job sandbox container.
 * A non-CLI adapter (e.g. an in-process SDK call) wouldn't need either —
 * it'd read its credentials directly at construction time. We keep these
 * fields on the port to avoid a parallel registry of "which adapters need
 * sandbox env injection"; the cost is one CLI assumption leaking into the
 * generic interface. Acceptable trade for take-home scope.
 */
export interface TestGenerator {
  /** Stable identifier for this adapter, e.g. 'claude', 'gemini'. */
  readonly id: string;
  /**
   * Env var names a sandbox-shelling adapter requires the orchestrator to
   * forward into the per-job container. Non-sandbox adapters return `[]`.
   */
  readonly requiredEnv: readonly string[];
  /** Env var names a sandbox-shelling adapter may use if present. Non-sandbox adapters return `[]`. */
  readonly optionalEnv: readonly string[];

  generateTest(input: GenerateTestInput): Promise<GenerateTestOutput>;
}
