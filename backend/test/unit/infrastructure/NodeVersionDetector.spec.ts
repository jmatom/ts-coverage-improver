import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeNodeVersion,
  detectNodeVersion,
} from '../../../src/infrastructure/coverage/NodeVersionDetector';

describe('detectNodeVersion', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'nvd-'));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  function writeNvmrc(content: string): void {
    writeFileSync(join(workdir, '.nvmrc'), content);
  }
  function writePkg(engines?: string | object): void {
    const pkg = engines === undefined ? {} : { engines: { node: engines } };
    writeFileSync(join(workdir, 'package.json'), JSON.stringify(pkg));
  }

  it('falls back to default when no pin exists', async () => {
    writePkg();
    const r = await detectNodeVersion(workdir);
    expect(r).toEqual({ version: '20', source: 'default', raw: null });
  });

  it('falls back to default when neither file exists', async () => {
    const r = await detectNodeVersion(workdir);
    expect(r).toEqual({ version: '20', source: 'default', raw: null });
  });

  it('reads .nvmrc with a bare major number', async () => {
    writeNvmrc('22');
    const r = await detectNodeVersion(workdir);
    expect(r).toEqual({ version: '22', source: '.nvmrc', raw: '22' });
  });

  it('reads .nvmrc with a full semver and trims whitespace/CRLF', async () => {
    writeNvmrc('  v22.5.0\r\n');
    const r = await detectNodeVersion(workdir);
    expect(r.version).toBe('22');
    expect(r.source).toBe('.nvmrc');
    expect(r.raw).toBe('v22.5.0');
  });

  it('.nvmrc takes precedence over package.json engines.node', async () => {
    writeNvmrc('18');
    writePkg('>=22');
    const r = await detectNodeVersion(workdir);
    expect(r.version).toBe('18');
    expect(r.source).toBe('.nvmrc');
  });

  it('reads engines.node "^24.0.0" → 24', async () => {
    writePkg('^24.0.0');
    const r = await detectNodeVersion(workdir);
    expect(r).toEqual({ version: '24', source: 'engines.node', raw: '^24.0.0' });
  });

  it('reads engines.node ">=18" — first integer wins (18)', async () => {
    writePkg('>=18');
    const r = await detectNodeVersion(workdir);
    expect(r.version).toBe('18');
  });

  it('falls back when engines.node pins an unsupported major (e.g. 19)', async () => {
    writePkg('19.0.0');
    const r = await detectNodeVersion(workdir);
    expect(r.version).toBe('20'); // default
    expect(r.source).toBe('default');
    expect(r.raw).toBe('19.0.0');
    expect(r.fallbackReason).toMatch(/Node 19.+not pre-installed/);
  });

  it('falls back when engines.node is unparseable (no integer)', async () => {
    writePkg('lts/iron');
    const r = await detectNodeVersion(workdir);
    // 'lts/iron' has no integer — falls back with the unparseable reason.
    expect(r.version).toBe('20');
    expect(r.fallbackReason).toMatch(/could not parse/);
  });

  it('treats malformed package.json as "no pin"', async () => {
    writeFileSync(join(workdir, 'package.json'), '{ this is not json');
    const r = await detectNodeVersion(workdir);
    expect(r).toEqual({ version: '20', source: 'default', raw: null });
  });

  it('treats package.json with no engines field as "no pin"', async () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    const r = await detectNodeVersion(workdir);
    expect(r.source).toBe('default');
  });

  it('treats engines.node="" as "no pin"', async () => {
    writePkg('   ');
    const r = await detectNodeVersion(workdir);
    expect(r.source).toBe('default');
  });
});

describe('describeNodeVersion', () => {
  it('renders a clear line for a successful .nvmrc detection', () => {
    expect(
      describeNodeVersion({ version: '22', source: '.nvmrc', raw: '22' }),
    ).toMatch(/Node version: 22 \(detected from \.nvmrc="22"\)/);
  });

  it('renders a clear line for an engines.node detection', () => {
    expect(
      describeNodeVersion({ version: '24', source: 'engines.node', raw: '^24.0.0' }),
    ).toMatch(/Node version: 24 \(detected from engines\.node="\^24\.0\.0"\)/);
  });

  it('renders a clear line for the default fallback (no pin)', () => {
    expect(
      describeNodeVersion({ version: '20', source: 'default', raw: null }),
    ).toMatch(/Node version: 20 .+sandbox default/);
  });

  it('renders the reason when a pin existed but was unsupported', () => {
    expect(
      describeNodeVersion({
        version: '20',
        source: 'default',
        raw: '19.0.0',
        fallbackReason: 'requested Node 19 but it is not pre-installed in the sandbox (supported: 18, 20, 22, 24)',
      }),
    ).toMatch(/Node 19.+falling back/);
  });
});
