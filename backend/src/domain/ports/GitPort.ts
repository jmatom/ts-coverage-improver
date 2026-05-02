export interface CloneInput {
  cloneUrl: string;
  branch?: string;
  workdir: string;
  token?: string;
}

export interface CommitAndPushInput {
  workdir: string;
  branch: string;
  filesToAdd: string[];
  message: string;
  remote?: string;
  remoteUrl: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Port for host-side git operations. Cloning and pushing happen on the host
 * (not in the sandbox) because the workdir produced by clone is what we
 * mount into the sandbox for AI and test runs.
 */
export interface GitPort {
  clone(input: CloneInput): Promise<{ commitSha: string }>;
  commitAndPush(input: CommitAndPushInput): Promise<void>;
  /**
   * Reset the workdir back to a clean checkout of HEAD — wipes any uncommitted
   * changes (including AI-written files from a failed attempt). Used between
   * orchestrator retry cycles so each attempt starts from a clean baseline.
   */
  resetWorkdir(workdir: string): Promise<void>;
}
