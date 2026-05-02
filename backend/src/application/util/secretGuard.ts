/**
 * Detects strings that look like a secret. Used to scan AI output (logs and
 * written file contents) before pushing a branch — a malicious target repo
 * may have planted prompt-injection content that tricks the AI into echoing
 * `process.env` or similar.
 *
 * Patterns are intentionally conservative; we'd rather false-positive (a
 * job fails with "looks like a secret leaked") than false-negative (a real
 * `sk-ant-…` token gets committed in a generated test file).
 */

interface SecretShape {
  readonly name: string;
  readonly pattern: RegExp;
}

const PATTERNS: readonly SecretShape[] = [
  // Anthropic API keys: sk-ant-api03-<base64ish>… historically 90+ chars,
  // we accept >=40 to be generous against future format changes.
  { name: 'anthropic-api-key', pattern: /sk-ant-api03-[A-Za-z0-9_-]{40,}/g },
  // GitHub classic PATs: ghp_ + 36 base62 chars.
  { name: 'github-classic-pat', pattern: /\bghp_[A-Za-z0-9]{36,}\b/g },
  // GitHub fine-grained PATs: github_pat_ + ~82 chars (id + secret).
  { name: 'github-finegrained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  // GitHub OAuth tokens (gho_), user tokens (ghu_), server-to-server (ghs_),
  // app refresh (ghr_) — same length class as ghp_.
  { name: 'github-other-token', pattern: /\bgh[ousr]_[A-Za-z0-9]{36,}\b/g },
  // Defensive: AWS access key id. We don't use it, but if a malicious repo
  // wrote one into the AI context to test our scanner, flag it anyway.
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

export interface SecretMatch {
  readonly name: string;
  /** First 6 chars of the matched string for the failure message. */
  readonly prefix: string;
}

/**
 * Returns the first secret match found in `text`, or `null` if none.
 * Stops at the first match — we just need a definitive yes/no for the
 * caller to fail the job; we don't enumerate every leak.
 */
export function findSuspectedSecret(text: string): SecretMatch | null {
  for (const shape of PATTERNS) {
    // Reset lastIndex; the constants are reused across calls.
    shape.pattern.lastIndex = 0;
    const m = shape.pattern.exec(text);
    if (m) {
      return {
        name: shape.name,
        prefix: m[0].slice(0, 6),
      };
    }
  }
  return null;
}
