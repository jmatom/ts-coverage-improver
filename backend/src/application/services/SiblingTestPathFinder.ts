import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Infrastructure service: probe the workdir for an existing sibling test
 * file and return its relative path, else null.
 *
 * Lives in `infrastructure/coverage/` because its job is filesystem
 * inspection. The list of conventions to probe is a heuristic ordering
 * (first match wins) — kept inline because it's tightly coupled to the
 * probe semantics.
 *
 * Probed locations (in order):
 *   <basename>.test.ts | .test.tsx | .spec.ts | .spec.tsx
 *   <dir>__tests__/<basename>.test.ts | .spec.ts
 *   test/<basename>.test.ts
 *   tests/<basename>.test.ts
 *
 * Used by:
 *   - AnalyzeRepositoryCoverage to populate `FileCoverage.hasExistingTest`
 *     so the dashboard can distinguish "needs append" from "needs sibling".
 *     Called once per file in the report — N file probes per analyze.
 *   - RunImprovementJob to choose append-vs-sibling mode at job time.
 *
 * Both callers run after a fresh clone so the filesystem state is canonical.
 *
 * Async to keep the event loop unblocked when N is large; the underlying
 * `fs.access` calls dispatch to libuv's threadpool.
 */
export class SiblingTestPathFinder {
  static async findExisting(
    workdir: string,
    sourcePath: string,
  ): Promise<string | null> {
    for (const c of SiblingTestPathFinder.candidatesFor(sourcePath)) {
      try {
        await access(join(workdir, c));
        return c;
      } catch {
        /* not found, try next candidate */
      }
    }
    return null;
  }

  /** Pure: enumerate candidate test paths for a given source file. */
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
