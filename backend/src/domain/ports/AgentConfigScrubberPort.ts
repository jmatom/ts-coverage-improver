/**
 * Port: pre-AI workdir hardening. Removes any agent-config files that an
 * attacker-controlled target repo might have planted to inject instructions
 * into the AI CLI (CLAUDE.md, .cursor/, .aider.*, AGENTS.md, etc.).
 *
 * Implementations are filesystem-bound; the application use case calls this
 * before each AI invocation. Returns the list of paths actually targeted
 * (for logging — the underlying `rm` is force-mode so non-existent paths
 * are silent).
 */
export interface AgentConfigScrubberPort {
  scrub(workdir: string): Promise<string[]>;
}
