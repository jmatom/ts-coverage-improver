import { SecretScanner } from '../../../../src/domain/security/SecretScanner';

describe('SecretScanner.findIn', () => {
  it('returns null on plain text', () => {
    expect(SecretScanner.findIn('hello world')).toBeNull();
    expect(SecretScanner.findIn('describe("foo", () => { it("works", () => {}); })')).toBeNull();
    expect(SecretScanner.findIn('')).toBeNull();
  });

  it('flags Anthropic API keys (sk-ant-api03-…)', () => {
    const fake = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF12345';
    const result = SecretScanner.findIn(`prefix ${fake} suffix`);
    expect(result?.name).toBe('anthropic-api-key');
    expect(result?.prefix.startsWith('sk-ant')).toBe(true);
  });

  it('flags GitHub classic PATs (ghp_…)', () => {
    const fake = 'ghp_' + 'A'.repeat(40);
    const result = SecretScanner.findIn(`token: ${fake}`);
    expect(result?.name).toBe('github-classic-pat');
  });

  it('flags GitHub fine-grained PATs (github_pat_…)', () => {
    const fake = 'github_pat_' + 'B'.repeat(82);
    expect(SecretScanner.findIn(fake)?.name).toBe('github-finegrained-pat');
  });

  it('flags other GitHub token shapes (gho_, ghs_, ghu_, ghr_)', () => {
    expect(SecretScanner.findIn('gho_' + 'X'.repeat(40))?.name).toBe('github-other-token');
    expect(SecretScanner.findIn('ghs_' + 'X'.repeat(40))?.name).toBe('github-other-token');
  });

  it('flags AWS access key IDs (AKIA…)', () => {
    expect(SecretScanner.findIn('id=AKIAIOSFODNN7EXAMPLE')?.name).toBe('aws-access-key-id');
  });

  it('does not match similar-looking strings under the length floor', () => {
    expect(SecretScanner.findIn('sk-ant-api03-tooshort')).toBeNull();
    expect(SecretScanner.findIn('ghp_short')).toBeNull();
  });

  it('returns the first match when multiple are present', () => {
    const text =
      'leak: sk-ant-api03-' + 'A'.repeat(50) + ' and ghp_' + 'B'.repeat(40);
    expect(SecretScanner.findIn(text)?.name).toBe('anthropic-api-key');
  });

  it('is reusable across calls (regex lastIndex hygiene)', () => {
    const fake = 'sk-ant-api03-' + 'C'.repeat(50);
    expect(SecretScanner.findIn(fake)).not.toBeNull();
    // Calling again with the same secret must still match — guards against
    // a regex /g flag bug where lastIndex carries over.
    expect(SecretScanner.findIn(fake)).not.toBeNull();
  });
});
