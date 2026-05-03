import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameworkDetector } from '../../../src/infrastructure/coverage/FrameworkDetector';

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fd-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('FrameworkDetector', () => {
  let dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });

  it('detects vitest + npm with lockfile', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({
        devDependencies: { vitest: '^1.0.0', '@vitest/coverage-v8': '^1.0.0' },
      }),
      'package-lock.json': '{}',
    });
    dirs.push(dir);
    const r = FrameworkDetector.detect(dir);
    expect(r.framework).toBe('vitest');
    expect(r.packageManager).toBe('npm');
    expect(r.installArgs).toEqual(['ci']);
    expect(r.testCmd).toContain('vitest');
    expect(r.testCmd.join(' ')).toMatch(/--coverage/);
  });

  it('detects jest + pnpm', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
      'pnpm-lock.yaml': '',
    });
    dirs.push(dir);
    const r = FrameworkDetector.detect(dir);
    expect(r.framework).toBe('jest');
    expect(r.packageManager).toBe('pnpm');
    expect(r.installArgs).toEqual(['install', '--frozen-lockfile']);
  });

  it('detects mocha+nyc', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({ devDependencies: { mocha: '^10', nyc: '^15' } }),
    });
    dirs.push(dir);
    const r = FrameworkDetector.detect(dir);
    expect(r.framework).toBe('mocha');
    expect(r.testCmd[0]).toBe('npx');
    expect(r.testCmd).toContain('nyc');
  });

  it('detects mocha+c8 (prefers c8 over nyc when both present)', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({
        devDependencies: { mocha: '^10', c8: '^9', nyc: '^15' },
      }),
    });
    dirs.push(dir);
    const r = FrameworkDetector.detect(dir);
    expect(r.testCmd).toContain('c8');
  });

  it('throws when no supported framework found', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({ devDependencies: { ava: '^5' } }),
    });
    dirs.push(dir);
    expect(() => FrameworkDetector.detect(dir)).toThrow(/Unsupported test framework/);
  });

  it('uses scripts.test when it already wraps coverage', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({
        scripts: { test: 'jest --coverage' },
        devDependencies: { jest: '^29' },
      }),
    });
    dirs.push(dir);
    const r = FrameworkDetector.detect(dir);
    expect(r.testCmd).toEqual(['npm', 'test', '--']);
  });

  it('throws when mocha detected but no coverage tool', () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({ devDependencies: { mocha: '^10' } }),
    });
    dirs.push(dir);
    expect(() => FrameworkDetector.detect(dir)).toThrow(/c8.*nyc/);
  });

  describe('defaultTestCmd', () => {
    // Contract: defaultTestCmd is the per-framework default coverage command
    // and IGNORES the project's scripts.test wrapping. Used by the empty-
    // suite handling in NpmCoverageRunner where flag pass-through via
    // `npm test --` is unreliable. testCmd still honors scripts.test for
    // the hot path; the two fields can diverge by design.

    it('jest: defaultTestCmd is the npx default even when scripts.test wraps coverage', () => {
      const dir = mkRepo({
        'package.json': JSON.stringify({
          scripts: { test: 'jest --coverage' },
          devDependencies: { jest: '^29.0.0' },
        }),
      });
      dirs.push(dir);
      const r = FrameworkDetector.detect(dir);
      expect(r.testCmd).toEqual(['npm', 'test', '--']);
      expect(r.defaultTestCmd).toContain('jest');
      expect(r.defaultTestCmd).toContain('--coverage');
      expect(r.defaultTestCmd).toContain('--coverageReporters=lcovonly');
    });

    it('vitest: defaultTestCmd ignores scripts.test wrapping', () => {
      const dir = mkRepo({
        'package.json': JSON.stringify({
          scripts: { test: 'vitest run --coverage' },
          devDependencies: { vitest: '^1.0.0' },
        }),
      });
      dirs.push(dir);
      const r = FrameworkDetector.detect(dir);
      expect(r.testCmd).toEqual(['npm', 'test', '--']);
      expect(r.defaultTestCmd).toContain('vitest');
      expect(r.defaultTestCmd).toContain('run');
      expect(r.defaultTestCmd).toContain('--coverage');
    });

    it('mocha + c8: defaultTestCmd uses c8 + mocha and ignores scripts.test wrapping', () => {
      const dir = mkRepo({
        'package.json': JSON.stringify({
          scripts: { test: 'c8 mocha' },
          devDependencies: { mocha: '^10', c8: '^9' },
        }),
      });
      dirs.push(dir);
      const r = FrameworkDetector.detect(dir);
      expect(r.testCmd).toEqual(['npm', 'test', '--']);
      expect(r.defaultTestCmd).toContain('c8');
      expect(r.defaultTestCmd).toContain('mocha');
      // Wrapper flags must come BEFORE 'mocha' for the empty-suite splice.
      expect(r.defaultTestCmd[r.defaultTestCmd.length - 1]).toBe('mocha');
    });

    it('non-wrapping case: testCmd === defaultTestCmd', () => {
      const dir = mkRepo({
        'package.json': JSON.stringify({
          devDependencies: { jest: '^29.0.0' },
        }),
      });
      dirs.push(dir);
      const r = FrameworkDetector.detect(dir);
      expect(r.testCmd).toEqual(r.defaultTestCmd);
    });
  });
});
