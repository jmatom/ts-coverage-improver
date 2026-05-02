export interface SandboxRunInput {
  /** Absolute host path to the workdir mounted into the container at /workspace. */
  workdir: string;
  /** Command to run inside /workspace. Argv form to avoid shell injection. */
  cmd: string[];
  /** Env vars to inject into the container (e.g. ANTHROPIC_API_KEY). */
  env?: Record<string, string>;
  /** Hard timeout in milliseconds; container is killed if exceeded. */
  timeoutMs?: number;
  /**
   * Optional Node major to run the command under, switching via fnm. The
   * sandbox image pre-installs a fixed set (see NodeVersionDetector
   * `SUPPORTED_NODE_MAJORS`); callers should pass one of those. When
   * omitted, the command runs on the image's baked-in Node 20 with no
   * fnm wrapper overhead.
   */
  nodeVersion?: string;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Port for running a command inside a disposable, network-restricted container.
 *
 * Honors the spec NFR "isolate AI CLI runs" — also used for `npm install` / test runs
 * since those execute untrusted code (postinstall scripts) from third-party repos.
 */
export interface SandboxPort {
  run(input: SandboxRunInput): Promise<SandboxRunResult>;

  /**
   * Boot-time check: verify the sandbox is operational (e.g. daemon reachable,
   * image present). Throws on any setup issue. Surfaces deployment problems
   * before the first improvement job hits them.
   */
  assertReady(): Promise<void>;
}
