import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectTestConvention } from '../../../src/application/util/detectTestConvention';

describe('detectTestConvention', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'detect-conv-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function touch(rel: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
  }

  it('defaults to "test" when no test files exist', async () => {
    writeFileSync(join(dir, 'README.md'), '# nothing');
    expect(await detectTestConvention(dir)).toBe('test');
  });

  it('returns "spec" when *.spec files dominate', async () => {
    touch('src/a.spec.ts');
    touch('src/b.spec.ts');
    touch('src/c.test.ts');
    expect(await detectTestConvention(dir)).toBe('spec');
  });

  it('returns "test" when *.test files dominate', async () => {
    touch('src/a.test.ts');
    touch('src/b.test.ts');
    touch('src/c.spec.ts');
    expect(await detectTestConvention(dir)).toBe('test');
  });

  it('breaks ties in favor of "test" (Jest default)', async () => {
    touch('src/a.test.ts');
    touch('src/b.spec.ts');
    expect(await detectTestConvention(dir)).toBe('test');
  });

  it('skips node_modules so vendored test files do not skew the count', async () => {
    touch('src/a.test.ts');
    // Lots of vendored .spec files inside node_modules — must NOT count.
    for (let i = 0; i < 20; i++) {
      touch(`node_modules/some-pkg/dist/x${i}.spec.ts`);
    }
    expect(await detectTestConvention(dir)).toBe('test');
  });

  it('counts .tsx, .js, .jsx, .mts, .cts variants too', async () => {
    touch('src/a.spec.tsx');
    touch('src/b.spec.js');
    touch('src/c.spec.mts');
    touch('src/d.test.ts');
    expect(await detectTestConvention(dir)).toBe('spec');
  });

  it('returns "test" for an empty directory', async () => {
    expect(await detectTestConvention(dir)).toBe('test');
  });
});
