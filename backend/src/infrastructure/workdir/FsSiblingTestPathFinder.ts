import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SiblingTestPathFinderPort } from '@domain/ports/SiblingTestPathFinderPort';

/**
 * `node:fs`-backed `SiblingTestPathFinderPort` implementation.
 *
 * Probed locations (first match wins):
 *   <basename>.test.ts | .test.tsx | .spec.ts | .spec.tsx
 *   <dir>__tests__/<basename>.test.ts | .spec.ts
 *   test/<basename>.test.ts
 *   tests/<basename>.test.ts
 *
 * Async (`fs.access` dispatches to libuv's threadpool) so callers running
 * many probes in parallel (`AnalyzeRepositoryCoverage` does this for every
 * file in a coverage report) keep the event loop free.
 */
export class FsSiblingTestPathFinder implements SiblingTestPathFinderPort {
  async findExisting(workdir: string, sourcePath: string): Promise<string | null> {
    for (const c of FsSiblingTestPathFinder.candidatesFor(sourcePath)) {
      try {
        await access(join(workdir, c));
        return c;
      } catch {
        /* not found, try next candidate */
      }
    }
    return null;
  }

  /** Pure: enumerate candidate test paths for a given source file. Exposed
   *  as a static for tests that want to assert on the candidate list
   *  without touching the filesystem. */
  static candidatesFor(sourcePath: string): string[] {
    const stem = basename(sourcePath).replace(/\.(ts|tsx|js|jsx|mts|cts)$/i, '');
    const dir = sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1)
      : '';
    return [
      `${dir}${stem}.test.ts`,
      `${dir}${stem}.test.tsx`,
      `${dir}${stem}.spec.ts`,
      `${dir}${stem}.spec.tsx`,
      `${dir}__tests__/${stem}.test.ts`,
      `${dir}__tests__/${stem}.spec.ts`,
      `test/${stem}.test.ts`,
      `tests/${stem}.test.ts`,
    ];
  }
}
