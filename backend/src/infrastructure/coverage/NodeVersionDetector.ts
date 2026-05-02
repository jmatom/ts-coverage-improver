import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the resolved Node version came from. Drives the log line shown to
 * the user so they can understand exactly why their project ran on Node X
 * inside the sandbox.
 */
export type NodeVersionSource = '.nvmrc' | 'engines.node' | 'default';

/** Node majors pre-installed in the sandbox image (see sandbox/Dockerfile). */
export const SUPPORTED_NODE_MAJORS = ['18', '20', '22', '24'] as const;
export type SupportedNodeMajor = (typeof SUPPORTED_NODE_MAJORS)[number];

/**
 * Default Node major when the project doesn't pin one (or pins something
 * unsupported). Matches the base image (`FROM node:20-slim`), so the
 * fallback path uses zero fnm overhead.
 */
export const DEFAULT_NODE_MAJOR: SupportedNodeMajor = '20';

export interface NodeVersionResolution {
  /** Major version the sandbox should use. Always one of the pre-installed set. */
  version: SupportedNodeMajor;
  source: NodeVersionSource;
  /** Raw value we found in the project, or null if we fell through to default. */
  raw: string | null;
  /**
   * Set when we detected a pin but couldn't honor it (unparseable, or major
   * not in the pre-installed set). Surfaced in the job log so the user
   * knows we had to fall back.
   */
  fallbackReason?: string;
}

/**
 * Decide which Node version to run the project on. Reads (in order of
 * precedence):
 *
 *   1. `.nvmrc` — explicit project pin, wins if present
 *   2. `package.json` `engines.node` — semver range or single version
 *   3. fall back to `DEFAULT_NODE_MAJOR`
 *
 * Returns a structured result so the caller can log a clear line for every
 * decision (detected from X, fell back because Y, default because nothing
 * was pinned). The first integer we find in the raw value is the major —
 * predictable for both `"20"` and ranges like `">=18 <22"`. If the parsed
 * major isn't in `SUPPORTED_NODE_MAJORS`, we fall back to the default and
 * record the reason.
 */
export async function detectNodeVersion(
  workdir: string,
): Promise<NodeVersionResolution> {
  // 1. .nvmrc — wins if present. Standard for nvm/fnm/volta projects.
  const nvmrc = await tryReadFile(join(workdir, '.nvmrc'));
  if (nvmrc !== null) {
    return resolveFromRaw(nvmrc, '.nvmrc');
  }

  // 2. package.json engines.node
  const pkgRaw = await tryReadFile(join(workdir, 'package.json'));
  if (pkgRaw !== null) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(pkgRaw);
    } catch {
      // Malformed package.json — let other infra surface it; for our purposes,
      // treat as "no pin" and continue to default.
      pkg = null;
    }
    const engines = (pkg as { engines?: { node?: unknown } } | null)?.engines?.node;
    if (typeof engines === 'string' && engines.trim() !== '') {
      return resolveFromRaw(engines, 'engines.node');
    }
  }

  // 3. Default — project didn't pin anything we can parse.
  return { version: DEFAULT_NODE_MAJOR, source: 'default', raw: null };
}

function resolveFromRaw(rawWithWhitespace: string, source: '.nvmrc' | 'engines.node'): NodeVersionResolution {
  const raw = rawWithWhitespace.trim();
  const match = raw.match(/(\d+)/);
  const parsed = match ? match[1] : null;

  if (parsed && (SUPPORTED_NODE_MAJORS as readonly string[]).includes(parsed)) {
    return { version: parsed as SupportedNodeMajor, source, raw };
  }

  // Detected something but couldn't honor it — fall back with a clear reason.
  const fallbackReason = parsed
    ? `requested Node ${parsed} but it is not pre-installed in the sandbox (supported: ${SUPPORTED_NODE_MAJORS.join(', ')})`
    : `could not parse "${raw}" as a Node version`;
  return {
    version: DEFAULT_NODE_MAJOR,
    source: 'default',
    raw,
    fallbackReason,
  };
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Render a resolution as a single-line job log entry. Centralized here so
 * the wording stays consistent across NpmTestRunner and any future caller
 * (if other phases ever need to surface the same info).
 */
export function describeNodeVersion(res: NodeVersionResolution): string {
  if (res.fallbackReason) {
    return `Node version: ${res.version} (${res.fallbackReason} — falling back to sandbox default)`;
  }
  if (res.source === 'default') {
    return `Node version: ${res.version} (project did not pin a version — using sandbox default)`;
  }
  return `Node version: ${res.version} (detected from ${res.source}="${res.raw}")`;
}
