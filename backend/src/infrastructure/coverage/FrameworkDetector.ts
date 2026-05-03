import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SupportedTestFramework } from '@domain/ports/TestGeneratorPort';
import {
  MissingMochaCoverageToolError,
  MissingPackageJsonError,
  UnsupportedTestFrameworkError,
} from '@domain/errors/DomainError';

export interface DetectionResult {
  framework: SupportedTestFramework;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  /** Argv to invoke install (after the package-manager binary). */
  installArgs: string[];
  /**
   * Argv to run the project's tests with coverage instrumentation, producing
   * `coverage/lcov.info`. Honors the project's own `scripts.test` if it
   * already wraps coverage; otherwise falls back to a per-framework default.
   */
  testCmd: string[];
  /**
   * The per-framework default coverage command — never honors
   * `scripts.test`. Used by the empty-suite handling path (where extra
   * flags like `--passWithNoTests` need to reach the framework binary
   * directly; they get lost or dropped when routed through `npm test --`).
   */
  defaultTestCmd: string[];
}

/**
 * Inspect a cloned repo to figure out (a) which package manager to use,
 * (b) which TS test framework is in play, and (c) what command produces a
 * coverage/lcov.info report.
 *
 * Detection is purely structural — `package.json` devDependencies + lockfile
 * presence. We do not run any code in the host process.
 */
export class FrameworkDetector {
  static detect(workdir: string): DetectionResult {
    const pkgPath = join(workdir, 'package.json');
    if (!existsSync(pkgPath)) {
      throw new MissingPackageJsonError(workdir);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    const packageManager: DetectionResult['packageManager'] = existsSync(
      join(workdir, 'pnpm-lock.yaml'),
    )
      ? 'pnpm'
      : existsSync(join(workdir, 'yarn.lock'))
        ? 'yarn'
        : 'npm';

    const installArgs: string[] =
      packageManager === 'pnpm'
        ? ['install', '--frozen-lockfile']
        : packageManager === 'yarn'
          ? ['install', '--frozen-lockfile']
          : existsSync(join(workdir, 'package-lock.json'))
            ? ['ci']
            : ['install'];

    const framework: SupportedTestFramework =
      'vitest' in allDeps
        ? 'vitest'
        : 'jest' in allDeps
          ? 'jest'
          : 'mocha' in allDeps
            ? 'mocha'
            : (() => {
                // Surface what we DID find that looks test-related, so the
                // user can debug "why doesn't my repo qualify?" in one glance.
                const testHints = Object.keys(allDeps).filter((d) =>
                  /^(ava|tap|jasmine|mocha-.*|@testing-library|chai|sinon)$/i.test(d),
                );
                throw new UnsupportedTestFrameworkError(testHints);
              })();

    const testCmd = FrameworkDetector.coverageCommand({
      framework,
      pkg,
      allDeps,
      packageManager,
    });
    const defaultTestCmd = FrameworkDetector.defaultCoverageCommand(framework, allDeps);

    return { framework, packageManager, installArgs, testCmd, defaultTestCmd };
  }

  /**
   * The per-framework default coverage command, ignoring whatever the
   * project's `scripts.test` does. Public so the runner can use it in
   * empty-suite mode where flag pass-through via `npm test --` is
   * unreliable (some scripts strip args or have their own `--`).
   */
  static defaultCoverageCommand(
    framework: SupportedTestFramework,
    allDeps: Record<string, string>,
  ): string[] {
    switch (framework) {
      case 'jest':
        return [
          'npx',
          '--yes',
          'jest',
          '--coverage',
          '--coverageReporters=lcovonly',
          '--coverageDirectory=coverage',
        ];
      case 'vitest':
        return ['npx', '--yes', 'vitest', 'run', '--coverage', '--coverage.reporter=lcovonly'];
      case 'mocha': {
        const tool = 'c8' in allDeps ? 'c8' : 'nyc' in allDeps ? 'nyc' : null;
        if (!tool) {
          throw new MissingMochaCoverageToolError();
        }
        return ['npx', '--yes', tool, '--reporter=lcovonly', 'mocha'];
      }
    }
  }

  /**
   * Choose a coverage command. Preference order:
   *   1. Project's own `scripts.test` if it already wraps coverage
   *      (we recognize "--coverage", "nyc ", "c8 ", "--reporter").
   *   2. Per-framework default that emits lcov to `coverage/lcov.info`.
   */
  private static coverageCommand(opts: {
    framework: SupportedTestFramework;
    pkg: { scripts?: Record<string, string> };
    allDeps: Record<string, string>;
    packageManager: 'npm' | 'pnpm' | 'yarn';
  }): string[] {
    const test = opts.pkg.scripts?.test ?? '';
    const wrapsCoverage = /(--coverage|\bnyc\b|\bc8\b|--reporter\b)/.test(test);
    const runViaPm =
      opts.packageManager === 'pnpm'
        ? ['pnpm', 'test']
        : opts.packageManager === 'yarn'
          ? ['yarn', 'test']
          : ['npm', 'test', '--'];

    if (wrapsCoverage) {
      return runViaPm;
    }

    return FrameworkDetector.defaultCoverageCommand(opts.framework, opts.allDeps);
  }
}
