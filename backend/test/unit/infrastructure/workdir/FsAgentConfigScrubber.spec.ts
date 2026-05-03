import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsAgentConfigScrubber } from '../../../../src/infrastructure/workdir/FsAgentConfigScrubber';

describe('FsAgentConfigScrubber.scrub', () => {
  const scrubber = new FsAgentConfigScrubber();
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'scrub-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const touch = (rel: string) => {
    const abs = join(workdir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'attacker payload');
  };

  it('removes a planted CLAUDE.md', async () => {
    touch('CLAUDE.md');
    await scrubber.scrub(workdir);
    expect(existsSync(join(workdir, 'CLAUDE.md'))).toBe(false);
  });

  it('removes a planted .claude/ directory recursively', async () => {
    touch('.claude/settings.json');
    touch('.claude/instructions.md');
    await scrubber.scrub(workdir);
    expect(existsSync(join(workdir, '.claude'))).toBe(false);
  });

  it('removes .cursor/ + .cursorrules + .continue/ + .aider.* + AGENTS.md', async () => {
    touch('.cursor/rules.md');
    touch('.cursorrules');
    touch('.continue/config.json');
    touch('.aider.conf.yml');
    touch('.aider.input.history');
    touch('AGENTS.md');
    touch('agents.md');
    await scrubber.scrub(workdir);
    for (const rel of [
      '.cursor',
      '.cursorrules',
      '.continue',
      '.aider.conf.yml',
      '.aider.input.history',
      'AGENTS.md',
      'agents.md',
    ]) {
      expect(existsSync(join(workdir, rel))).toBe(false);
    }
  });

  it('does not remove unrelated files', async () => {
    touch('src/keepme.ts');
    touch('package.json');
    touch('README.md');
    await scrubber.scrub(workdir);
    expect(existsSync(join(workdir, 'src/keepme.ts'))).toBe(true);
    expect(existsSync(join(workdir, 'package.json'))).toBe(true);
    expect(existsSync(join(workdir, 'README.md'))).toBe(true);
  });

  it('is a no-op when no targets exist', async () => {
    const result = await scrubber.scrub(workdir);
    // The function tries every target — `force: true` makes ENOENT silent,
    // so all paths appear in the "removed" list. The contract is that the
    // workdir's non-target contents are untouched.
    expect(result.length).toBeGreaterThan(0);
  });

  it('exposes its targets list as `FsAgentConfigScrubber.targets`', () => {
    expect(FsAgentConfigScrubber.targets).toContain('CLAUDE.md');
    expect(FsAgentConfigScrubber.targets).toContain('.claude');
    expect(FsAgentConfigScrubber.targets.length).toBeGreaterThan(5);
  });
});
