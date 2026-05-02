import { simpleGit, SimpleGit } from 'simple-git';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { CloneInput, CommitAndPushInput, GitPort } from '@domain/ports/GitPort';

/**
 * GitPort implementation backed by `simple-git`.
 *
 * Path / URL handling:
 *  - PAT is embedded in the URL as `https://x-access-token:<TOKEN>@github.com/...`
 *    when the caller passes one (private repo support, also avoids interactive
 *    credential prompts in the sandbox).
 *  - workdir is wiped and recreated on clone to guarantee a clean checkout
 *    between attempts (jobs are disposable).
 */
export class SimpleGitCloner implements GitPort {
  async clone(input: CloneInput): Promise<{ commitSha: string }> {
    if (existsSync(input.workdir)) {
      rmSync(input.workdir, { recursive: true, force: true });
    }
    mkdirSync(input.workdir, { recursive: true });

    const url = input.token
      ? input.cloneUrl.replace('https://', `https://x-access-token:${input.token}@`)
      : input.cloneUrl;

    const git = simpleGit({ baseDir: input.workdir });
    await git.clone(url, '.', input.branch ? ['--branch', input.branch, '--single-branch'] : []);
    const sha = (await git.revparse(['HEAD'])).trim();
    return { commitSha: sha };
  }

  async commitAndPush(input: CommitAndPushInput): Promise<void> {
    const git: SimpleGit = simpleGit({ baseDir: input.workdir });
    await git
      .addConfig('user.email', input.authorEmail ?? 'coverage-improver-bot@users.noreply.github.com')
      .addConfig('user.name', input.authorName ?? 'Coverage Improver Bot');

    const remote = input.remote ?? 'fork';
    const remotes = await git.getRemotes(true);
    if (!remotes.find((r) => r.name === remote)) {
      await git.addRemote(remote, input.remoteUrl);
    } else {
      await git.remote(['set-url', remote, input.remoteUrl]);
    }

    await git.checkoutLocalBranch(input.branch);
    await git.add(input.filesToAdd);
    await git.commit(input.message);
    await git.push(remote, input.branch, ['--set-upstream']);
  }

  async resetWorkdir(workdir: string): Promise<void> {
    const git = simpleGit({ baseDir: workdir });
    await git.reset(['--hard']);
    await git.clean('f', ['-d']);
  }
}
