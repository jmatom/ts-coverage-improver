import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateTestPaths,
  findExistingTestPath,
} from '../../../src/application/util/findExistingTestPath';

describe('candidateTestPaths', () => {
  it('expands all common conventions for a top-level source file', () => {
    const cands = candidateTestPaths('foo.ts');
    expect(cands).toEqual([
      'foo.test.ts',
      'foo.test.tsx',
      'foo.spec.ts',
      'foo.spec.tsx',
      '__tests__/foo.test.ts',
      '__tests__/foo.spec.ts',
      'test/foo.test.ts',
      'tests/foo.test.ts',
    ]);
  });

  it('keeps the source dir as a prefix for nested files', () => {
    const cands = candidateTestPaths('src/lib/foo.ts');
    expect(cands).toContain('src/lib/foo.test.ts');
    expect(cands).toContain('src/lib/__tests__/foo.test.ts');
  });

  it('strips a variety of source extensions', () => {
    expect(candidateTestPaths('foo.tsx')[0]).toBe('foo.test.ts');
    expect(candidateTestPaths('foo.js')[0]).toBe('foo.test.ts');
    expect(candidateTestPaths('foo.mts')[0]).toBe('foo.test.ts');
    expect(candidateTestPaths('foo.cts')[0]).toBe('foo.test.ts');
  });
});

describe('findExistingTestPath', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'find-test-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const touch = (rel: string) => {
    const abs = join(workdir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '');
  };

  it('returns null when no test file exists', async () => {
    touch('src/foo.ts');
    await expect(findExistingTestPath(workdir, 'src/foo.ts')).resolves.toBeNull();
  });

  it('finds a sibling .test.ts', async () => {
    touch('src/foo.ts');
    touch('src/foo.test.ts');
    await expect(findExistingTestPath(workdir, 'src/foo.ts')).resolves.toBe('src/foo.test.ts');
  });

  it('finds a sibling .spec.ts', async () => {
    touch('src/foo.ts');
    touch('src/foo.spec.ts');
    await expect(findExistingTestPath(workdir, 'src/foo.ts')).resolves.toBe('src/foo.spec.ts');
  });

  it('finds __tests__ co-located test', async () => {
    touch('src/lib/foo.ts');
    touch('src/lib/__tests__/foo.test.ts');
    await expect(findExistingTestPath(workdir, 'src/lib/foo.ts')).resolves.toBe(
      'src/lib/__tests__/foo.test.ts',
    );
  });

  it('finds top-level test/<name>.test.ts', async () => {
    touch('lib/foo.ts');
    touch('test/foo.test.ts');
    await expect(findExistingTestPath(workdir, 'lib/foo.ts')).resolves.toBe('test/foo.test.ts');
  });

  it('first match wins (sibling .test.ts beats __tests__)', async () => {
    touch('src/foo.ts');
    touch('src/foo.test.ts');
    touch('src/__tests__/foo.test.ts');
    await expect(findExistingTestPath(workdir, 'src/foo.ts')).resolves.toBe('src/foo.test.ts');
  });
});
