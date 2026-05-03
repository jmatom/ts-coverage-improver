import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CoverageRunInput,
  CoverageRunResult,
  CoverageRunnerPort,
} from '@domain/ports/CoverageRunnerPort';
import { SandboxPort } from '@domain/ports/SandboxPort';
import { LcovParser } from '@domain/coverage/LcovParser';
import { FrameworkDetector } from './FrameworkDetector';
import { describeNodeVersion, detectNodeVersion } from './NodeVersionDetector';
import {
  emptySuiteFlags,
  hasAnyTestFile,
  writePlaceholderTest,
} from './EmptySuiteHandling';

/**
 * Real CoverageRunnerPort: runs `<pm> install` + the framework-appropriate
 * coverage command in the sandbox, then parses `coverage/lcov.info`.
 *
 * The runner trusts the SandboxPort to enforce isolation — we just hand
 * over commands and read back the artifact from disk.
 */
export class NpmCoverageRunner implements CoverageRunnerPort {
  constructor(private readonly sandbox: SandboxPort) {}

  async run(input: CoverageRunInput): Promise<CoverageRunResult> {
    const detection = FrameworkDetector.detect(input.workdir);
    const nodeRes = await detectNodeVersion(input.workdir);
    const logs: string[] = [
      `Detected framework: ${detection.framework} (${detection.packageManager})`,
      describeNodeVersion(nodeRes),
    ];
    // Pass nodeVersion to the sandbox only when we actually detected a pin.
    // Default-source results run on the image's baked Node 20 with no fnm
    // wrapper overhead.
    const sandboxNodeVersion =
      nodeRes.source === 'default' ? undefined : nodeRes.version;

    // Shortcut: if the repo committed a `coverage/lcov.info`, reuse it.
    // Day-2 post-AI validation always re-runs tests, so this only fires
    // on the initial AnalyzeRepositoryCoverage path.
    const committedLcov = join(input.workdir, 'coverage', 'lcov.info');
    if (await fileExists(committedLcov)) {
      logs.push('Reusing committed coverage/lcov.info — skipping install + test');
      return {
        framework: detection.framework,
        files: LcovParser.parse(await readFile(committedLcov, 'utf8')),
        logs: logs.join('\n'),
      };
    }

    // Install
    const install = await this.sandbox.run({
      workdir: input.workdir,
      cmd: [detection.packageManager, ...detection.installArgs],
      timeoutMs: 5 * 60_000,
      nodeVersion: sandboxNodeVersion,
    });
    logs.push(`[install] exit=${install.exitCode} (${install.durationMs}ms)`);
    if (install.exitCode !== 0) {
      throw new Error(
        `Install failed (exit ${install.exitCode}):\n${tail(install.stdout, install.stderr)}`,
      );
    }

    // Empty-suite handling: a repo with zero tests is a legitimate baseline
    // (every project starts here). Without intervention jest/vitest exit
    // non-zero on "no tests found" and our flow short-circuits with a useless
    // error. Inside the disposable workdir we drop a placeholder test (so
    // the runner exits 0) and add coverage flags so lcov lists every source
    // file at 0% — giving the dashboard rows the user can click Improve on.
    // See EmptySuiteHandling.ts for the per-framework flag set + caveats.
    let testCmd = detection.testCmd;
    if (!(await hasAnyTestFile(input.workdir))) {
      if (detection.framework === 'mocha') {
        throw new Error(
          'No tests found in this repository. Empty-suite handling is currently ' +
            'supported for jest and vitest only — mocha + nyc/c8 has no equivalent ' +
            'of jest --collectCoverageFrom. Add at least one test file to proceed.',
        );
      }
      await writePlaceholderTest(input.workdir, detection.framework);
      testCmd = [...detection.testCmd, ...emptySuiteFlags(detection.framework)];
      logs.push(
        'No tests detected — wrote placeholder + appended empty-suite flags ' +
          `(${detection.framework})`,
      );
    }

    // Test with coverage
    const test = await this.sandbox.run({
      workdir: input.workdir,
      cmd: testCmd,
      timeoutMs: 10 * 60_000,
      nodeVersion: sandboxNodeVersion,
    });
    logs.push(`[test] exit=${test.exitCode} (${test.durationMs}ms)`);
    // Note: a non-zero exit doesn't always mean "tests failed" — some setups
    // exit non-zero on threshold violations even when lcov was produced.
    // We require the lcov file to exist; the parser tolerates partial data.

    const lcovPath = join(input.workdir, 'coverage', 'lcov.info');
    if (!(await fileExists(lcovPath))) {
      throw new Error(
        `Coverage report not produced (looked for coverage/lcov.info)\n` +
          tail(test.stdout, test.stderr),
      );
    }
    const files = LcovParser.parse(await readFile(lcovPath, 'utf8'));

    return {
      framework: detection.framework,
      files,
      logs: logs.join('\n'),
    };
  }
}

function tail(stdout: string, stderr: string, n = 4000): string {
  const combined = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
  return combined.length > n ? '…' + combined.slice(-n) : combined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
