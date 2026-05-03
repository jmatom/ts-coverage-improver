import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Infrastructure service: pre-AI hardening that deletes any agent-config
 * files an attacker-controlled target repo might have planted to inject
 * instructions into Claude Code (or another AI CLI).
 *
 * The threat: a malicious `package.json` `postinstall` (or a file shipped
 * directly in the repo) can write a `CLAUDE.md`, `.claude/settings.json`,
 * `.cursor/rules/...`, etc. Claude Code reads these at startup as
 * "project context", which is a direct prompt-injection vector.
 *
 * Lives in `infrastructure/security/` because it mutates the filesystem
 * (calls `rm`). The list of paths to scrub is a security policy that
 * could conceivably move to domain in a "what counts as an agent
 * config" sense, but since the policy ships hand-in-hand with the
 * mutation it's clearer to keep them together.
 *
 * `RunImprovementJob` calls this after the install phase but before
 * the AI-invocation phase, so any agent-config the install left behind
 * is also scrubbed.
 *
 * Returns the list of paths actually removed, for logging.
 */
const TARGETS: readonly string[] = [
  'CLAUDE.md',
  'claude.md',
  'CLAUDE.local.md',
  '.claude',
  '.cursor',
  '.cursorrules',
  '.continue',
  '.aider.conf.yml',
  '.aider.input.history',
  'AGENTS.md',
  'agents.md',
];

export class AgentConfigScrubber {
  /** Targets exposed for tests; not for runtime use. */
  static readonly targets: readonly string[] = TARGETS;

  static async scrub(workdir: string): Promise<string[]> {
    const removed: string[] = [];
    await Promise.all(
      TARGETS.map(async (rel) => {
        const abs = join(workdir, rel);
        try {
          await rm(abs, { recursive: true, force: true });
          // `force: true` makes ENOENT a no-op so we can't tell from the
          // error whether anything was actually removed; we don't try
          // (the list is small and the call is cheap).
          removed.push(rel);
        } catch (e) {
          // Truly unexpected error (permission, EBUSY) — surface it via
          // the logger but don't fail the job; agent-config scrubbing is
          // belt-and-suspenders, not a hard requirement.
          removed.push(`${rel} (rm error: ${(e as Error).message})`);
        }
      }),
    );
    return removed;
  }
}
