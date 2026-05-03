import { DomainInvariantError } from '../errors/DomainError';

/**
 * Value object: a clean repo-relative subpath (or empty for repo root).
 *
 * Replaces `Repository.normalizeSubpath` private helper. Centralizes
 * the security-critical invariant that workdir paths can't contain
 * `..` segments — without this check, a malicious or careless registration
 * could escape the cloned workdir via path traversal.
 *
 * Invariants enforced at construction:
 *   - never starts with '/' or contains '..' segments
 *   - leading/trailing slashes trimmed
 *   - whitespace trimmed
 *   - empty input → empty `value` (= repo root, the common case)
 *
 * Immutable. `equals()` is structural. `.value` exposes the raw `string`
 * for path joining (`path.join(cloneRoot, subpath.value)`) and serialization.
 */
export class Subpath {
  private constructor(public readonly value: string) {}

  /**
   * Construct from a raw user-supplied string, normalizing whitespace and
   * slashes. Throws on path-traversal attempts. Empty input is allowed
   * and represents "repo root" (the single-package common case).
   */
  static of(raw: string): Subpath {
    const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (trimmed === '') return new Subpath('');
    if (trimmed.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new DomainInvariantError(
        `Subpath must be a clean relative path (no '..', no leading '/'); got '${raw}'`,
      );
    }
    return new Subpath(trimmed);
  }

  static empty(): Subpath {
    return new Subpath('');
  }

  isEmpty(): boolean {
    return this.value === '';
  }

  equals(other: Subpath): boolean {
    return this.value === other.value;
  }
}
