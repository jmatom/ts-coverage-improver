export interface GitHubRepoMeta {
  defaultBranch: string;
  cloneUrl: string;
  isPrivate: boolean;
  forkingAllowed: boolean;
}

export interface OpenPullRequestInput {
  upstream: { owner: string; name: string };
  fork: { owner: string; name: string };
  headBranch: string; // branch on the fork
  baseBranch: string; // branch on the upstream
  title: string;
  body: string;
}

/**
 * Port for GitHub operations. Implementation uses Octokit (infrastructure).
 *
 * Domain code calls these methods without knowing how they're authenticated
 * or routed; the adapter handles PAT, retries, error mapping.
 */
export interface GitHubPort {
  /**
   * Verify the configured token is valid and return the authenticated user's
   * login. Used at boot to surface bad/expired PATs immediately rather than
   * waiting for the first improvement job to fail at fork time.
   */
  whoami(): Promise<string>;

  /** Fetch repo metadata (default branch, private flag, fork allowance). */
  getRepositoryMeta(owner: string, name: string): Promise<GitHubRepoMeta>;

  /**
   * Idempotent fork creation under the PAT user.
   * - If a fork already exists, returns its `{ owner, name }`.
   * - Otherwise creates one and returns the new `{ owner, name }`.
   */
  ensureFork(upstream: { owner: string; name: string }): Promise<{ owner: string; name: string }>;

  /** Open a PR from `fork:headBranch` against `upstream:baseBranch`. Returns the PR's HTML URL. */
  openPullRequest(input: OpenPullRequestInput): Promise<string>;
}
