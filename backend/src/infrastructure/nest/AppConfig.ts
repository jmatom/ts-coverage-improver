/**
 * Application configuration loaded from process.env.
 *
 * Single source of truth for runtime config. Nest providers depend on
 * AppConfig (via DI token), never read process.env directly. Required
 * env vars are validated at module instantiation — boot fails fast if
 * any are missing.
 */
export interface AppConfig {
  port: number;
  databasePath: string;
  jobWorkdirRoot: string;
  defaultCoverageThreshold: number;
  githubToken: string;
  aiCli: string;
  sandboxImage: string;
  dockerSocketPath: string;
  /** Max simultaneous sandbox container spawns (host-bound: memory, disk, dockerd). */
  maxConcurrentSandboxes: number;
  /** Max simultaneous AI invocations (account-bound: rate limits, credit cost). */
  maxConcurrentAiCalls: number;
  /** Max active (pending+running) jobs across system; 0 = no cap. Beyond this, new requests get 503. */
  maxQueueDepth: number;
  // Adapter-specific env vars are validated by the AI module against the
  // selected adapter's requiredEnv declaration.
  rawEnv: NodeJS.ProcessEnv;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = ['GITHUB_TOKEN'];
  for (const key of required) {
    if (!env[key] || env[key].trim() === '') {
      throw new Error(`Missing required env var: ${key}`);
    }
  }
  const threshold = Number(env.DEFAULT_COVERAGE_THRESHOLD ?? 80);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error(
      `Invalid DEFAULT_COVERAGE_THRESHOLD: must be a number in [0, 100]; got "${env.DEFAULT_COVERAGE_THRESHOLD}"`,
    );
  }
  const maxConcurrentSandboxes = parsePositiveInt(
    env.MAX_CONCURRENT_SANDBOXES,
    4,
    'MAX_CONCURRENT_SANDBOXES',
  );
  const maxConcurrentAiCalls = parsePositiveInt(
    env.MAX_CONCURRENT_AI_CALLS,
    2,
    'MAX_CONCURRENT_AI_CALLS',
  );
  const maxQueueDepth = parseNonNegativeInt(env.MAX_QUEUE_DEPTH, 50, 'MAX_QUEUE_DEPTH');
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? './data/coverage.db',
    jobWorkdirRoot: env.JOB_WORKDIR_ROOT ?? '/tmp/coverage-improver-jobs',
    defaultCoverageThreshold: threshold,
    githubToken: env.GITHUB_TOKEN!,
    aiCli: (env.AI_CLI ?? 'claude').toLowerCase(),
    sandboxImage: env.SANDBOX_IMAGE ?? 'coverage-improver-sandbox:latest',
    dockerSocketPath: env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock',
    maxConcurrentSandboxes,
    maxConcurrentAiCalls,
    maxQueueDepth,
    rawEnv: env,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${name}: must be a positive integer; got "${raw}"`);
  }
  return n;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: must be a non-negative integer; got "${raw}"`);
  }
  return n;
}
