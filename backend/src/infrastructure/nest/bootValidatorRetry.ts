/**
 * Helpers for the boot-time validators in `AppModule.onModuleInit`.
 *
 * Why these exist: Docker's embedded DNS resolver (127.0.0.11) sometimes
 * returns `EAI_AGAIN` for the first external lookup right after a cold
 * container start — the constant literally means "try again later." The
 * previous implementation treated any error from `whoami()` as fatal AND
 * blamed the GITHUB_TOKEN, sending operators on a multi-minute
 * token-debugging detour for a flaky-resolver problem.
 */

/**
 * Codes Node / libc / Octokit surface for transient DNS / connection failures.
 * `EAI_AGAIN` is the canonical "try again later" signal; the others are
 * network-layer hiccups (DNS NXDOMAIN cache thrash, mid-flight connection
 * drops, daemon back-pressure).
 */
export const TRANSIENT_NETWORK_CODES = [
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
] as const;

export function isTransientNetworkError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && (TRANSIENT_NETWORK_CODES as readonly string[]).includes(code)) {
    return true;
  }
  // Octokit wraps the underlying error; check the message as a safety net
  // when `.code` isn't propagated to the outer error.
  const message = (e as Error).message ?? '';
  return TRANSIENT_NETWORK_CODES.some((c) => message.includes(c));
}

/**
 * Retry a thunk on transient network errors with exponential backoff
 * (200ms, 500ms, 1s, 2s, 4s — total ~7.7s worst case before giving up).
 *
 * Non-transient errors (HTTP 4xx auth failures, etc.) propagate immediately
 * without burning the retry budget on a problem that won't fix itself.
 */
export async function retryOnTransientNetwork<T>(
  fn: () => Promise<T>,
  backoffsMs: readonly number[] = [200, 500, 1000, 2000, 4000],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isTransientNetworkError(e) || attempt === backoffsMs.length) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]).unref());
    }
  }
  throw lastError;
}

/**
 * Discriminate the boot-validator error so the message tells the operator
 * something useful. Network failures (DNS, connection) point at infra; auth
 * failures (HTTP 4xx) point at the token. Conflating them sends operators
 * on a wrong investigation.
 */
export function formatGithubBootError(e: unknown): string {
  const err = e as Error;
  if (isTransientNetworkError(e)) {
    return (
      `Could not reach api.github.com after retries: ${err.message}. ` +
      `This is a network/DNS issue inside the backend container, not a token problem — ` +
      `the token was never validated. Common causes: VPN interfering with Docker NAT, ` +
      `Docker Desktop's embedded DNS resolver in a bad state (a Docker Desktop restart ` +
      `usually clears this), or upstream DNS provider unreachable.`
    );
  }
  return (
    `GitHub PAT validation failed: ${err.message}. Check GITHUB_TOKEN scope (need 'repo') ` +
    `and that the token has not expired.`
  );
}
