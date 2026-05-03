import { simpleGit } from 'simple-git';
import { TestGenerator, GenerateTestInput, GenerateTestOutput } from '@domain/ports/TestGeneratorPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { buildTestGenerationPrompt } from './prompt';

/**
 * TestGenerator implementation backed by Claude Code (`claude -p` headless mode).
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
export class ClaudeCliTestGenerator implements TestGenerator {
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
  // `git status --porcelain=v1` has a fixed-width header: XY<space><path>
  // where X is the index status, Y is the worktree status, columns 0..1.
  // For unstaged-modified files X is space (' M'), so we MUST NOT trim
  // leading whitespace before slicing — doing so eats the first character
  // of the path. We strip only the trailing newline.
  const git = simpleGit({ baseDir: workdir });
  const status = await git.raw(['status', '--porcelain']);
  const files: string[] = [];
  for (const rawLine of status.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    // Header: XY<space><path>. Path starts at column 3 verbatim.
    const code = line.slice(0, 2).replace(/ /g, '').trim();
    const path = line.slice(3);
    if (!path) continue;
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
