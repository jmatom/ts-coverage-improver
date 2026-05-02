import { simpleGit } from 'simple-git';
import { AICliPort, GenerateTestInput, GenerateTestOutput } from '@domain/ports/AICliPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { buildTestGenerationPrompt } from './prompt';

/**
 * AICliPort implementation backed by Claude Code (`claude -p` headless mode).
 *
 * Contract surface:
 *  - `requiredEnv = ['ANTHROPIC_API_KEY']` — adapter never reads process.env;
 *    the orchestrator looks this up and forwards via `input.env`.
 *  - The prompt is constructed by `buildTestGenerationPrompt` and passed to
 *    Claude as a single argv string; long prompts are fine (well under ARG_MAX).
 *  - Written-files discovery uses `git status --porcelain` against the cloned
 *    workdir — works for any AI CLI that touches files via its own tools.
 *
 * Why `--dangerously-skip-permissions`: Claude's tool prompts are interactive.
 * In our sandbox the container itself is the trust boundary (network NAT'd,
 * filesystem isolated to /workspace), so we tell Claude to act without asking.
 *
 * The Day-2 plan calls out one more invariant the adapter does NOT enforce:
 * passing tests / coverage delta / AST safety. Those are validated by
 * `RunImprovementJob` after this method returns. The adapter's only job is
 * "hand the prompt to the CLI and report back which files were written."
 */
export class ClaudeCodeAdapter implements AICliPort {
  readonly id = 'claude';
  readonly requiredEnv = ['ANTHROPIC_API_KEY'] as const;
  readonly optionalEnv = ['ANTHROPIC_BASE_URL'] as const;

  constructor(private readonly sandbox: SandboxPort) {}

  async generateTest(input: GenerateTestInput): Promise<GenerateTestOutput> {
    const prompt = await buildTestGenerationPrompt(input);
    const result = await this.sandbox.run({
      workdir: input.workdir,
      cmd: [
        'claude',
        '-p',
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
        prompt,
      ],
      env: input.env,
      timeoutMs: 5 * 60_000,
    });

    if (result.exitCode !== 0) {
      // Claude's `-p --output-format json` returns a single JSON object on
      // stdout even when the underlying API call failed. Parse it so we can
      // surface a friendly reason (e.g. "Credit balance is too low" → billing
      // issue) instead of dumping the raw payload into the job log.
      const friendly = extractClaudeError(result.stdout);
      if (friendly) {
        throw new Error(`Claude API ${friendly.status}: ${friendly.message}`);
      }
      throw new Error(
        `Claude CLI exited ${result.exitCode}: ${tail(result.stdout, result.stderr)}`,
      );
    }

    const writtenFiles = await diffWrittenFiles(input.workdir);
    return {
      writtenFiles,
      logs: [
        `[claude] exit=0 (${result.durationMs}ms)`,
        ...sliceForLog(result.stdout, 8000),
      ].join('\n'),
    };
  }
}

async function diffWrittenFiles(workdir: string): Promise<string[]> {
  // `git status --porcelain` reports modified/added files relative to repo root.
  // We accept M (modified), A (added), and ?? (untracked) lines. Renames are
  // unlikely from a single AI run; if they appear we'd see them as R lines.
  const git = simpleGit({ baseDir: workdir });
  const status = await git.raw(['status', '--porcelain']);
  const files: string[] = [];
  for (const rawLine of status.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const code = line.slice(0, 2).trim();
    const path = line.slice(3).trim();
    if (code === 'M' || code === 'A' || code === '??' || code === 'AM' || code === 'MM') {
      files.push(path);
    }
  }
  return files;
}

function tail(stdout: string, stderr: string, n = 2000): string {
  const combined = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
  return combined.length > n ? '…' + combined.slice(-n) : combined;
}

/**
 * Pull a friendly `{status, message}` out of Claude CLI's JSON output when
 * the API call inside the CLI failed. Examples we want to surface cleanly:
 *   - 400 "Credit balance is too low"  → billing not topped up
 *   - 401 "invalid x-api-key"          → ANTHROPIC_API_KEY wrong / expired
 *   - 429 "rate_limit_error"           → too many requests
 * Returns null when the payload doesn't look like an API-error envelope, so
 * the caller falls back to the generic exit-code message.
 */
function extractClaudeError(
  stdout: string,
): { status: number | string; message: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as {
      is_error?: boolean;
      api_error_status?: number | string;
      result?: string;
    };
    if (obj.is_error && obj.result) {
      return { status: obj.api_error_status ?? 'error', message: obj.result };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function sliceForLog(s: string, n: number): string[] {
  if (!s) return [];
  return [s.length > n ? '…' + s.slice(-n) : s];
}
