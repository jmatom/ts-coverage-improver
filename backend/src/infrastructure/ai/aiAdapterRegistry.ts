import { TestGenerator } from '@domain/ports/TestGeneratorPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { ClaudeCliTestGenerator } from './ClaudeCliTestGenerator';

/**
 * Adapter registry for the "via any AI CLI" seam.
 *
 * Adding a new adapter is a one-line change here plus a Dockerfile update for
 * the CLI binary — see README "Adding a new AI CLI adapter."
 *
 * Selection is driven by the `AI_CLI` env var. The registry validates that
 * the chosen adapter's `requiredEnv` keys are populated at boot, so the app
 * fails fast if the operator forgot to set credentials.
 */
const REGISTRY: Record<string, (sandbox: SandboxPort) => TestGenerator> = {
  claude: (s) => new ClaudeCliTestGenerator(s),
  // To enable Gemini in production:
  //   1. Rename GeminiCliTestGenerator.example.ts → GeminiCliTestGenerator.ts
  //   2. Add `gemini: (s) => new GeminiCliTestGenerator(s),` here
  //   3. Add the gemini CLI install line to sandbox/Dockerfile
};

export function selectAiAdapter(
  id: string,
  sandbox: SandboxPort,
  env: NodeJS.ProcessEnv,
): TestGenerator {
  const factory = REGISTRY[id.toLowerCase()];
  if (!factory) {
    throw new Error(
      `Unknown AI_CLI '${id}'. Supported: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  const adapter = factory(sandbox);
  for (const key of adapter.requiredEnv) {
    if (!env[key] || env[key]!.trim() === '') {
      throw new Error(
        `AI adapter '${adapter.id}' requires env var ${key} but it is unset`,
      );
    }
  }
  return adapter;
}

export function resolveAiEnv(
  required: readonly string[],
  optional: readonly string[],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of required) {
    if (!env[k]) throw new Error(`Missing required AI env var: ${k}`);
    out[k] = env[k]!;
  }
  for (const k of optional) {
    if (env[k]) out[k] = env[k]!;
  }
  return out;
}
