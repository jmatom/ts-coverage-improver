import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLACEHOLDER_DIR,
  PLACEHOLDER_FILE,
  emptySuiteFlags,
  hasAnyTestFile,
  writePlaceholderTest,
} from '../../../src/infrastructure/coverage/EmptySuiteHandling';

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'esh-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('EmptySuiteHandling', () => {
  let dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });

  describe('hasAnyTestFile', () => {
    it('returns false for a repo with only source files', async () => {
      const dir = mkRepo({
        'package.json': '{}',
        'src/calc.ts': 'export const add = (a:number,b:number)=>a+b;',
        'src/util.ts': 'export const noop = () => {};',
      });
      dirs.push(dir);
      expect(await hasAnyTestFile(dir)).toBe(false);
    });

    it('finds a top-level *.test.ts', async () => {
      const dir = mkRepo({
        'package.json': '{}',
        'src/calc.test.ts': 'describe("",()=>{it("",()=>{});});',
      });
      dirs.push(dir);
      expect(await hasAnyTestFile(dir)).toBe(true);
    });

    it('finds a *.spec.tsx in a nested directory', async () => {
      const dir = mkRepo({
        'package.json': '{}',
        'src/components/Button.spec.tsx': '',
      });
      dirs.push(dir);
      expect(await hasAnyTestFile(dir)).toBe(true);
    });

    it('finds an entry inside __tests__/', async () => {
      const dir = mkRepo({
        'package.json': '{}',
        'src/__tests__/calc.ts': '',
      });
      dirs.push(dir);
      expect(await hasAnyTestFile(dir)).toBe(true);
    });

    it('skips node_modules even if it contains test files', async () => {
      // A real-world node_modules tree contains thousands of *.test.* files
      // (every published package's own tests). Including them in the probe
      // would (a) take forever and (b) make every install-only repo look
      // like it has tests. Skip pattern keeps us honest.
      const dir = mkRepo({
        'package.json': '{}',
        'node_modules/some-pkg/index.test.js': 'fixture',
        'src/calc.ts': 'export {};',
      });
      dirs.push(dir);
      expect(await hasAnyTestFile(dir)).toBe(false);
    });

    it('ignores its own placeholder if the runner wrote one previously', async () => {
      // Re-running analyze on the same workdir would normally find the
      // placeholder we wrote last time and short-circuit the empty-suite
      // path. The probe must skip the placeholder dir to stay honest about
      // user-authored tests.
      const dir = mkRepo({
        'package.json': '{}',
        [`${PLACEHOLDER_DIR}/${PLACEHOLDER_FILE}`]: 'fixture',
        'src/calc.ts': 'export {};',
      });
      dirs.push(dir);
      expect(await hasAnyTestFile(dir)).toBe(false);
    });
  });

  describe('writePlaceholderTest', () => {
    it('writes a jest-flavored placeholder under __improver-placeholder__/', async () => {
      const dir = mkRepo({ 'package.json': '{}' });
      dirs.push(dir);
      await writePlaceholderTest(dir, 'jest');
      const p = join(dir, PLACEHOLDER_DIR, PLACEHOLDER_FILE);
      expect(existsSync(p)).toBe(true);
      const content = readFileSync(p, 'utf8');
      // Jest auto-injects globals — no `import` statement should appear.
      expect(content).not.toMatch(/^import /m);
      expect(content).toMatch(/describe\(/);
      expect(content).toMatch(/it\(/);
    });

    it('writes a vitest-flavored placeholder with explicit imports', async () => {
      const dir = mkRepo({ 'package.json': '{}' });
      dirs.push(dir);
      await writePlaceholderTest(dir, 'vitest');
      const content = readFileSync(join(dir, PLACEHOLDER_DIR, PLACEHOLDER_FILE), 'utf8');
      // Vitest may not have globals enabled; explicit import is required for
      // describe/it to resolve regardless of the project's `globals:` config.
      expect(content).toMatch(/^import \{ describe, it \} from 'vitest';/m);
    });

    it('is idempotent — overwriting twice is a no-op', async () => {
      const dir = mkRepo({ 'package.json': '{}' });
      dirs.push(dir);
      await writePlaceholderTest(dir, 'jest');
      await writePlaceholderTest(dir, 'jest');
      expect(existsSync(join(dir, PLACEHOLDER_DIR, PLACEHOLDER_FILE))).toBe(true);
    });
  });

  describe('emptySuiteFlags', () => {
    it('jest gets --passWithNoTests + collectCoverageFrom + placeholder exclusion', () => {
      const flags = emptySuiteFlags('jest');
      expect(flags).toContain('--passWithNoTests');
      expect(flags.some((f) => f.startsWith('--collectCoverageFrom=src/'))).toBe(true);
      expect(flags.some((f) => f.includes(`!**/${PLACEHOLDER_DIR}/**`))).toBe(true);
      // Test files must be excluded from coverage so the table doesn't show
      // them as 0%-covered alongside real source files.
      expect(flags).toContain('--collectCoverageFrom=!**/*.test.*');
      expect(flags).toContain('--collectCoverageFrom=!**/*.spec.*');
    });

    it('vitest gets --passWithNoTests + coverage.include + placeholder exclusion', () => {
      const flags = emptySuiteFlags('vitest');
      expect(flags).toContain('--passWithNoTests');
      expect(flags.some((f) => f.startsWith('--coverage.include=src/'))).toBe(true);
      expect(flags.some((f) => f.includes(`${PLACEHOLDER_DIR}/**`))).toBe(true);
    });

    it('mocha returns an empty flag set (handled by the runner with an explicit error)', () => {
      expect(emptySuiteFlags('mocha')).toEqual([]);
    });
  });
});
