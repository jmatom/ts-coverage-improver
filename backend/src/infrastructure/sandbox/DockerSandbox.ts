import Docker from 'dockerode';
import {
  SandboxPort,
  SandboxRunInput,
  SandboxRunResult,
} from '@domain/ports/SandboxPort';

export interface DockerSandboxOptions {
  /** Image tag to use, e.g. "coverage-improver-sandbox:latest" */
  image: string;
  /**
   * Optional Docker connection settings. Defaults to the local socket
   * `/var/run/docker.sock`. When the backend itself runs inside a
   * container in docker-compose, the host socket is mounted at the same
   * path so spawned containers actually run on the host daemon.
   */
  socketPath?: string;
  /** Default timeout for a single run (ms). May be overridden per call. */
  defaultTimeoutMs?: number;
}

/**
 * SandboxPort impl using `dockerode`.
 *
 * Path semantics: `workdir` is treated as a *host* path. When the backend is
 * itself containerized, docker-compose must bind-mount the same host path
 * into the backend at the same path, so `workdir` resolves consistently in
 * both the backend's filesystem and the host docker daemon's view.
 *
 * Implementation note: we use `container.logs({ follow: false })` AFTER
 * `wait()` returns, instead of attaching upfront. The attach-then-wait
 * pattern is prone to stream-flush deadlocks with `demuxStream`; reading
 * logs after the container exits is simpler and reliable.
 */
export class DockerSandbox implements SandboxPort {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: DockerSandboxOptions) {
    this.docker = new Docker(opts.socketPath ? { socketPath: opts.socketPath } : undefined);
    this.image = opts.image;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60_000;
  }

  async assertReady(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (e) {
      throw new Error(
        `Docker daemon not reachable: ${(e as Error).message}. ` +
          `Check that Docker is running and DOCKER_SOCKET_PATH points at a live socket.`,
      );
    }
    try {
      await this.docker.getImage(this.image).inspect();
    } catch (e) {
      throw new Error(
        `Sandbox image '${this.image}' not present on the daemon: ${(e as Error).message}. ` +
          `Run \`docker compose up --build\` (the sandbox service builds it) or build manually with \`docker build -t ${this.image} sandbox/\`.`,
      );
    }
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const start = Date.now();
    const envArr = Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const cmd = wrapWithNodeVersion(input.cmd, input.nodeVersion);

    const container = await this.docker.createContainer({
      Image: this.image,
      Cmd: cmd,
      Env: envArr,
      WorkingDir: '/workspace',
      Tty: false,
      HostConfig: {
        AutoRemove: false,
        Binds: [`${input.workdir}:/workspace`],
        // NetworkMode left as default ("bridge"). Egress allow-listing is
        // documented as roadmap — would require a custom network + iptables.
      },
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      await container.start();

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        container.kill({ signal: 'SIGKILL' }).catch(() => undefined);
      }, timeoutMs);

      const result = await container.wait();
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const [stdout, stderr] = await Promise.all([
        readLogStream(container, { stdout: true, stderr: false }),
        readLogStream(container, { stdout: false, stderr: true }),
      ]);

      return {
        exitCode: timedOut ? 124 : Number(result.StatusCode ?? 1),
        stdout,
        stderr: stderr + (timedOut ? `\n[sandbox] killed after ${timeoutMs}ms timeout` : ''),
        durationMs: Date.now() - start,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        await container.remove({ force: true });
      } catch {
        /* container may already be gone */
      }
    }
  }
}

/**
 * Read stdout XOR stderr from a stopped container's log buffer.
 *
 * Docker's log stream is multiplexed: each frame is prefixed with an 8-byte
 * header where byte 0 is the stream id (1=stdout, 2=stderr). When you
 * request only one stream, Docker still emits the multiplexed format unless
 * you set Tty=true. Since our containers have Tty=false, we strip the
 * 8-byte headers manually rather than pull in `demuxStream` on a
 * post-mortem buffer.
 */
async function readLogStream(
  container: Docker.Container,
  opts: { stdout: boolean; stderr: boolean },
): Promise<string> {
  const stream = (await container.logs({
    follow: false,
    stdout: opts.stdout,
    stderr: opts.stderr,
    timestamps: false,
  })) as unknown as Buffer;
  return stripDockerHeaders(Buffer.from(stream));
}

/**
 * Wrap argv with `fnm exec --using <major>` when a per-job Node version is
 * requested. The sandbox image pre-installs a fixed set of majors (see
 * sandbox/Dockerfile). When `nodeVersion` is omitted, the command runs as
 * argv directly on the image's baked-in Node — zero wrapper overhead.
 *
 * Why `bash -c` (non-login): the Dockerfile's `ENV PATH=...` puts fnm on
 * PATH for non-login shells. A login shell (`-l`) re-sources `/etc/profile`
 * and clobbers PATH back to the system default, dropping fnm. `bash -c`
 * inherits the container env cleanly. The argv elements are joined with
 * shell-safe quoting because fnm's `--` passthrough still goes through
 * bash's lexer.
 */
export function wrapWithNodeVersion(cmd: string[], nodeVersion?: string): string[] {
  if (!nodeVersion) return cmd;
  const quoted = cmd.map(shellQuote).join(' ');
  return [
    'bash',
    '-c',
    `fnm exec --using=${shellQuote(nodeVersion)} -- ${quoted}`,
  ];
}

/** Conservative single-quote shell escape — never produces unquoted output. */
function shellQuote(arg: string): string {
  // Wrap in single quotes; escape any embedded single-quote by closing,
  // adding a literal `\'`, and reopening. Standard bash idiom.
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function stripDockerHeaders(buf: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end));
    i = end;
  }
  // If headers weren't present (e.g., older daemon), return raw.
  if (out.length === 0) return buf.toString('utf8');
  return Buffer.concat(out).toString('utf8');
}
