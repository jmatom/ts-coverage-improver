import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TestConvention } from '@domain/job/testFileNaming';

/**
 * Infrastructure service: walk a package root and decide which sibling-test
 * naming convention the project uses (`<base>.test.<ext>` vs `<base>.spec.<ext>`).
 *
 * Lives in `infrastructure/coverage/` because its job is filesystem
 * inspection — same shape as `FrameworkDetector` and `NodeVersionDetector`.
 * The decision *rule* (count-based, default to 'test' on tie/empty) is
 * trivial enough to live alongside the I/O without splitting domain/infra.
 *
 * Default: `'test'` when (a) no existing test files are found at all, or
 * (b) both suffixes appear at exactly the same count. Matches Jest's
 * "official" recommendation and the historical orchestrator behavior, so
 * single-package repos that haven't picked a side keep working unchanged.
 *
 * Skips: `node_modules`, dotfiles, `dist`, `build`, `coverage`. Caps walk
 * depth at 6 levels — deep enough for monorepo layouts (`apps/X/src/__tests__/...`)
 * without exploding on path-pathological cases.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.cache',
]);

const MAX_DEPTH = 6;

export class TestConventionDetector {
  static async detect(packageRoot: string): Promise<TestConvention> {
    let testCount = 0;
    let specCount = 0;

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > MAX_DEPTH) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        // `withFileTypes: true` returns Dirent on most platforms but on
        // bind-mounts via Docker Desktop's macOS file-sharing the type is
        // sometimes `unknown`. Fall back to `stat` only when needed.
        let isDir = entry.isDirectory();
        if (!isDir && !entry.isFile() && !entry.isSymbolicLink()) {
          try {
            isDir = (await stat(full)).isDirectory();
          } catch {
            continue;
          }
        }
        if (isDir) {
          await walk(full, depth + 1);
          continue;
        }
        // Match foo.test.ts / foo.spec.ts / .tsx / .js / .jsx / .mts / .cts.
        const m = entry.name.match(/\.(test|spec)\.[cm]?[tj]sx?$/);
        if (!m) continue;
        if (m[1] === 'test') testCount++;
        else specCount++;
      }
    }

    await walk(packageRoot, 0);

    if (specCount > testCount) return 'spec';
    return 'test';
  }
}
