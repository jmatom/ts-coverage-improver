import { findSuspectedSecret } from '../../../src/application/util/secretGuard';

describe('findSuspectedSecret', () => {
  it('returns null on plain text', () => {
    expect(findSuspectedSecret('hello world')).toBeNull();
    expect(findSuspectedSecret('describe("foo", () => { it("works", () => {}); })')).toBeNull();
    expect(findSuspectedSecret('')).toBeNull();
  });

  it('flags Anthropic API keys (sk-ant-api03-…)', () => {
    const fake = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF12345';
    const result = findSuspectedSecret(`prefix ${fake} suffix`);
    expect(result?.name).toBe('anthropic-api-key');
    expect(result?.prefix.startsWith('sk-ant')).toBe(true);
  });

  it('flags GitHub classic PATs (ghp_…)', () => {
    const fake = 'ghp_' + 'A'.repeat(40);
    const result = findSuspectedSecret(`token: ${fake}`);
    expect(result?.name).toBe('github-classic-pat');
  });

  it('flags GitHub fine-grained PATs (github_pat_…)', () => {
    const fake = 'github_pat_' + 'B'.repeat(82);
    expect(findSuspectedSecret(fake)?.name).toBe('github-finegrained-pat');
  });

  it('flags other GitHub token shapes (gho_, ghs_, ghu_, ghr_)', () => {
    expect(findSuspectedSecret('gho_' + 'X'.repeat(40))?.name).toBe('github-other-token');
    expect(findSuspectedSecret('ghs_' + 'X'.repeat(40))?.name).toBe('github-other-token');
  });

  it('flags AWS access key IDs (AKIA…)', () => {
    expect(findSuspectedSecret('id=AKIAIOSFODNN7EXAMPLE')?.name).toBe('aws-access-key-id');
  });

  it('does not match similar-looking strings under the length floor', () => {
    expect(findSuspectedSecret('sk-ant-api03-tooshort')).toBeNull();
    expect(findSuspectedSecret('ghp_short')).toBeNull();
  });

  it('returns the first match when multiple are present', () => {
    const text =
      'leak: sk-ant-api03-' + 'A'.repeat(50) + ' and ghp_' + 'B'.repeat(40);
    expect(findSuspectedSecret(text)?.name).toBe('anthropic-api-key');
  });

  it('is reusable across calls (regex lastIndex hygiene)', () => {
    const fake = 'sk-ant-api03-' + 'C'.repeat(50);
    expect(findSuspectedSecret(fake)).not.toBeNull();
    // Calling again with the same secret must still match — guards against
    // a regex /g flag bug where lastIndex carries over.
    expect(findSuspectedSecret(fake)).not.toBeNull();
  });
});
