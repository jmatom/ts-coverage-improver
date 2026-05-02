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
});
