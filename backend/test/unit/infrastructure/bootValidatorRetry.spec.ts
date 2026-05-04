import {
  formatGithubBootError,
  isTransientNetworkError,
  retryOnTransientNetwork,
} from '../../../src/infrastructure/nest/bootValidatorRetry';

function networkError(code: string): NodeJS.ErrnoException {
  const e = new Error(`getaddrinfo ${code} api.github.com`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function authError(): Error {
  return new Error('Bad credentials');
}

describe('isTransientNetworkError', () => {
  it.each(['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'])(
    'recognizes %s by .code',
    (code) => {
      expect(isTransientNetworkError(networkError(code))).toBe(true);
    },
  );

  it('recognizes a transient error by message text when .code is missing (Octokit wrapping)', () => {
    const wrapped = new Error('Request failed: getaddrinfo EAI_AGAIN api.github.com');
    expect(isTransientNetworkError(wrapped)).toBe(true);
  });

  it('does NOT classify auth errors as transient', () => {
    expect(isTransientNetworkError(authError())).toBe(false);
  });

  it('does NOT classify HTTP 4xx errors as transient', () => {
    const httpErr = new Error('HttpError: Resource not accessible by personal access token');
    expect(isTransientNetworkError(httpErr)).toBe(false);
  });
});

describe('retryOnTransientNetwork', () => {
  // Sub-millisecond backoffs keep the test fast; the retry semantics
  // are independent of the exact delay values.
  const fastBackoffs = [1, 1, 1, 1, 1] as const;

  it('returns immediately on success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retryOnTransientNetwork(fn, fastBackoffs);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and succeeds on a later attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(networkError('EAI_AGAIN'))
      .mockRejectedValueOnce(networkError('EAI_AGAIN'))
      .mockResolvedValueOnce('eventually-ok');
    const result = await retryOnTransientNetwork(fn, fastBackoffs);
    expect(result).toBe('eventually-ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on non-transient errors (auth)', async () => {
    const fn = jest.fn().mockRejectedValue(authError());
    await expect(retryOnTransientNetwork(fn, fastBackoffs)).rejects.toThrow('Bad credentials');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the backoff list is exhausted, surfacing the last error', async () => {
    const fn = jest.fn().mockRejectedValue(networkError('EAI_AGAIN'));
    await expect(retryOnTransientNetwork(fn, fastBackoffs)).rejects.toThrow(/EAI_AGAIN/);
    // attempts = backoffs.length + 1 (first try plus one retry per backoff)
    expect(fn).toHaveBeenCalledTimes(fastBackoffs.length + 1);
  });
});

describe('formatGithubBootError', () => {
  it('emits a NETWORK-focused message for transient network errors', () => {
    const msg = formatGithubBootError(networkError('EAI_AGAIN'));
    expect(msg).toMatch(/Could not reach api\.github\.com/i);
    expect(msg).toMatch(/network\/DNS/i);
    expect(msg).toMatch(/token was never validated/i);
    // Critically, must NOT blame the token — that's the bug we're fixing.
    expect(msg).not.toMatch(/Check GITHUB_TOKEN scope/i);
  });

  it('emits a TOKEN-focused message for auth errors', () => {
    const msg = formatGithubBootError(authError());
    expect(msg).toMatch(/GITHUB_TOKEN scope/);
    expect(msg).toMatch(/Bad credentials/);
    expect(msg).not.toMatch(/network/i);
  });
});
