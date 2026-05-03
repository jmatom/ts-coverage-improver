import { Octokit } from '@octokit/rest';
import {
  GitHubPort,
  GitHubRepoMeta,
  OpenPullRequestInput,
} from '@domain/ports/GitHubPort';

/**
 * GitHubPort implementation backed by `@octokit/rest`.
 *
 * Auth: PAT supplied at construction. The PAT user becomes the fork owner
 * for `ensureFork` (the standard fork-and-PR flow we picked in design).
 *
 * `ensureFork` is idempotent — if a fork already exists under the PAT user,
 * we reuse it. GitHub's "create fork" endpoint is itself idempotent in
 * practice (returns the existing fork), but we prefer an explicit lookup so
 * we don't silently churn the API.
 */
export class OctokitGitHub implements GitHubPort {
  private readonly octokit: Octokit;
  private cachedAuthLogin: string | null = null;

  constructor(token: string) {
    if (!token) throw new Error('GitHub PAT is required');
    this.octokit = new Octokit({ auth: token });
  }

  async whoami(): Promise<string> {
    return this.authenticatedLogin();
  }

  async getRepositoryMeta(owner: string, name: string): Promise<GitHubRepoMeta> {
    const { data } = await this.octokit.repos.get({ owner, repo: name });
    return {
      defaultBranch: data.default_branch,
      cloneUrl: data.clone_url,
      isPrivate: data.private,
      // GitHub returns `forking_allowed`/`allow_forking` only in some contexts;
      // default to true when the field isn't present (public repos always allow forks).
      forkingAllowed: data.allow_forking ?? true,
    };
  }

  async ensureFork(upstream: { owner: string; name: string }): Promise<{
    owner: string;
    name: string;
  }> {
    const me = await this.authenticatedLogin();

    // Has the PAT user already forked? GitHub stores forks of `<owner>/<name>`
    // by repo name (with rare disambiguation suffixes), so we look up by name
    // under the user's account.
    try {
      const { data } = await this.octokit.repos.get({ owner: me, repo: upstream.name });
      if (data.fork && data.parent?.owner?.login === upstream.owner) {
        return { owner: me, name: data.name };
      }
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status !== 404) throw e;
    }

    // Create the fork. GitHub's API is asynchronous — the fork may not be
    // immediately clonable. The `repos.createFork` call returns 202 with the
    // forked repo metadata; cloning typically works within seconds.
    const { data } = await this.octokit.repos.createFork({
      owner: upstream.owner,
      repo: upstream.name,
    });
    return { owner: data.owner.login, name: data.name };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<string> {
    const head = `${input.fork.owner}:${input.headBranch}`;
    const { data } = await this.octokit.pulls.create({
      owner: input.upstream.owner,
      repo: input.upstream.name,
      title: input.title,
      body: input.body,
      head,
      base: input.baseBranch,
      maintainer_can_modify: true,
    });
    return data.html_url;
  }

  private async authenticatedLogin(): Promise<string> {
    if (this.cachedAuthLogin) return this.cachedAuthLogin;
    const { data } = await this.octokit.users.getAuthenticated();
    this.cachedAuthLogin = data.login;
    return this.cachedAuthLogin;
  }
}
