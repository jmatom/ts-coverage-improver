import { DockerSandbox } from '../../src/infrastructure/sandbox/DockerSandbox';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Live integration test against the real `coverage-improver-sandbox` image.
 * Skipped when the image isn't available locally — keeps CI green on machines
 * where the operator hasn't built the image yet.
 *
 * Run with: `npm test -- --testPathPattern=integration/DockerSandbox`
 */
const HAS_DOCKER = (() => {
  try {
    require('node:child_process').execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const HAS_IMAGE = (() => {
  if (!HAS_DOCKER) return false;
  try {
    const out = require('node:child_process').execSync(
      'docker image ls --format "{{.Repository}}:{{.Tag}}"',
      { encoding: 'utf8' },
    );
    return /coverage-improver-sandbox:latest/.test(out);
  } catch {
    return false;
  }
})();

(HAS_IMAGE ? describe : describe.skip)('DockerSandbox (integration)', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'coverage-improver-sandbox-test-'));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  const sandbox = new DockerSandbox({ image: 'coverage-improver-sandbox:latest' });

  it('runs a simple command inside the container with workdir mounted', async () => {
    writeFileSync(join(workdir, 'hello.txt'), 'world');
    const result = await sandbox.run({
      workdir,
      cmd: ['cat', 'hello.txt'],
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('world');
  }, 60_000);

  it('writes from the container are visible on the host', async () => {
    const result = await sandbox.run({
      workdir,
      cmd: ['sh', '-c', 'echo from-sandbox > out.txt'],
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workdir, 'out.txt'))).toBe(true);
  }, 60_000);

  it('forwards env vars', async () => {
    const result = await sandbox.run({
      workdir,
      cmd: ['sh', '-c', 'echo $COVERAGE_IMPROVER_VAR'],
      env: { COVERAGE_IMPROVER_VAR: 'value-here' },
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('value-here');
  }, 60_000);

  it('assertReady succeeds when daemon is reachable + image exists', async () => {
    await sandbox.assertReady();
  }, 30_000);

  it('assertReady throws with a helpful message when image is missing', async () => {
    const missing = new DockerSandbox({
      image: 'coverage-improver-image-that-does-not-exist:latest',
    });
    await expect(missing.assertReady()).rejects.toThrow(
      /not present on the daemon|No such image/i,
    );
  }, 30_000);
});
