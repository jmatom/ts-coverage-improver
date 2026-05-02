import { wrapWithNodeVersion } from '../../../src/infrastructure/sandbox/DockerSandbox';

describe('wrapWithNodeVersion', () => {
  it('returns argv unchanged when no version is requested', () => {
    expect(wrapWithNodeVersion(['npm', 'ci'])).toEqual(['npm', 'ci']);
    expect(wrapWithNodeVersion(['claude', '-p', 'hello'])).toEqual([
      'claude',
      '-p',
      'hello',
    ]);
  });

  it('wraps with `bash -c fnm exec --using=<v> --` when a version is set', () => {
    const out = wrapWithNodeVersion(['npm', 'ci'], '22');
    expect(out[0]).toBe('bash');
    expect(out[1]).toBe('-c');
    expect(out[2]).toBe("fnm exec --using='22' -- 'npm' 'ci'");
  });

  it('quotes argv elements safely (no shell injection via spaces or quotes)', () => {
    const out = wrapWithNodeVersion(
      ['claude', '-p', "you said 'hi' & ran rm -rf /"],
      '24',
    );
    // Embedded single-quote becomes the standard '\''  idiom; no unquoted
    // ampersand or rm -rf can leak out of the literal.
    expect(out[2]).toContain(`'you said '\\''hi'\\'' & ran rm -rf /'`);
    expect(out[2].startsWith(`fnm exec --using='24' -- `)).toBe(true);
  });

  it('quotes the version itself (paranoia: never trust the caller)', () => {
    const out = wrapWithNodeVersion(['node', '--version'], `20'; rm -rf /`);
    expect(out[2]).toContain(`fnm exec --using='20'\\''; rm -rf /'`);
  });
});
