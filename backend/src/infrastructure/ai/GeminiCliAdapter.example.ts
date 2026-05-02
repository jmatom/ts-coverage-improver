/**
 * NOT WIRED.
 *
 * This file is the documented seam for "via any AI CLI" — a working sketch
 * of what a second adapter looks like. It demonstrates:
 *
 *   1. The same `AICliPort` contract — same input/output shape.
 *   2. A different `requiredEnv` (Gemini uses `GEMINI_API_KEY`, not Anthropic's).
 *   3. A different CLI binary invocation.
 *   4. The same post-run file discovery via `git status --porcelain`,
 *      because that strategy is CLI-agnostic.
 *
 * To enable in production:
 *   1. Rename to `GeminiCliAdapter.ts` (drop the `.example` suffix).
 *   2. Add the Gemini CLI install line to `sandbox/Dockerfile`.
 *   3. Register it in `AiModule` and set `AI_CLI=gemini` + `GEMINI_API_KEY`.
 *
 * No domain or application code changes — that's the whole point.
 */

import { simpleGit } from 'simple-git';
import {
  AICliPort,
  GenerateTestInput,
  GenerateTestOutput,
} from '@domain/ports/AICliPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { buildTestGenerationPrompt } from './prompt';

export class GeminiCliAdapter implements AICliPort {
  readonly id = 'gemini';
  readonly requiredEnv = ['GEMINI_API_KEY'] as const;
  readonly optionalEnv = [] as const;

  constructor(private readonly sandbox: SandboxPort) {}

  async generateTest(input: GenerateTestInput): Promise<GenerateTestOutput> {
    const prompt = await buildTestGenerationPrompt(input);
    // Hypothetical Gemini CLI invocation. Argv may differ slightly from the
    // real `gemini` CLI; the point is the contract, not the syntax.
    const result = await this.sandbox.run({
      workdir: input.workdir,
      cmd: ['gemini', 'chat', '--model=gemini-2.5-pro', '--prompt', prompt],
      env: input.env,
      timeoutMs: 5 * 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Gemini CLI exited ${result.exitCode}: ${result.stderr}`);
    }
    const git = simpleGit({ baseDir: input.workdir });
    const status = await git.raw(['status', '--porcelain']);
    const writtenFiles = status
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    return { writtenFiles, logs: result.stdout };
  }
}
