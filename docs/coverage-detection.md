# How coverage detection & calculation works

This service does **not** compute coverage itself. It runs each target
project's own coverage tool inside a sandboxed Docker container and parses
the resulting `coverage/lcov.info`. The only framework-specific code is the
small detection layer that picks **what** to invoke; everything downstream
is framework-agnostic and operates on the lcov common-denominator format.

## High-level flow

```
                   clone (host)
                        │
                        ▼
              FrameworkDetector.detect()
              ├─ require package.json
              ├─ pick package manager (npm / pnpm / yarn)
              ├─ identify test framework (vitest / jest / mocha)
              └─ build install + test command lines
                        │
                        ▼
                  DockerSandbox
              ├─ run install
              └─ run testCmd  ──► writes coverage/lcov.info
                        │
                        ▼
                 LcovParser.parse()       (framework-agnostic)
                        │
                        ▼
              FileCoverage[] persisted to SQLite
              ├─ linesPct, branchesPct, functionsPct
              ├─ uncoveredLines
              └─ hasExistingTest (probed against workdir)
```

The lcov file is the choke point. Jest, Vitest, and Mocha+c8/nyc all emit
the same Istanbul lcov format, so the parser, persistence layer, and UI
are blind to which framework produced the report.

## Framework detection ladder

`backend/src/infrastructure/coverage/FrameworkDetector.ts:32`

Detection is purely **structural** — `package.json` content + lockfile
presence. We do not execute any project code in the host process.

1. **`package.json` must exist.** Otherwise → `MissingPackageJsonError`
   ("this repo doesn't look like a Node project").
2. **Package manager** picked from lockfile presence:
   | Lockfile | Manager |
   |---|---|
   | `pnpm-lock.yaml` | pnpm |
   | `yarn.lock` | yarn |
   | `package-lock.json` | npm (uses `npm ci`) |
   | none | npm (uses `npm install`) |
3. **Test framework** detected by dependency presence, in priority order:

   | First match in `dependencies` ∪ `devDependencies` | Framework |
   |---|---|
   | `vitest` | vitest |
   | `jest` | jest |
   | `mocha` (then look for `c8` or `nyc`) | mocha |
   | none of the above | **`UnsupportedTestFrameworkError`** with a hint listing test-related deps we *did* find (`ava`, `tap`, `jasmine`, `chai`, `sinon`, `@testing-library/*`) so the user knows immediately why their repo didn't qualify |

   Mocha additionally requires `c8` or `nyc` as a devDep. If neither is
   present → `MissingMochaCoverageToolError`.

## Coverage command, framework-aware

`FrameworkDetector.coverageCommand()` builds the test invocation:

| Framework | Command |
|---|---|
| Jest    | `npx jest --coverage --coverageReporters=lcovonly --coverageDirectory=coverage` |
| Vitest  | `npx vitest run --coverage --coverage.reporter=lcovonly` |
| Mocha + c8 | `npx c8 --reporter=lcovonly mocha` |
| Mocha + nyc | `npx nyc --reporter=lcovonly mocha` |

All four produce `coverage/lcov.info` in the workdir, which the runner
then reads and parses.

## "Honor-thy-project" shortcut

Before applying the per-framework default, we check the project's own
`scripts.test`. If it already wraps coverage — regex match for any of
`--coverage`, `nyc `, `c8 `, or `--reporter` — we **do not override**. We
simply run `npm test` / `pnpm test` / `yarn test`.

Why: projects with custom coverage thresholds, reporters, or matcher
configs deserve to keep that configuration. Forcing our default would
silently override their setup.

The trade-off: if the project's wrapper happens to emit only non-lcov
reporters (e.g. `text-summary`), no `coverage/lcov.info` will be produced
and `NpmTestRunner` raises a clear error ("Coverage report not produced
— looked for `coverage/lcov.info`").

## Why `sum.test.ts` doesn't appear as a coverage row

We don't filter test files at our layer — Jest does. By default
Jest's `collectCoverageFrom` excludes `*.test.*` and `*.spec.*` from
instrumentation, so Istanbul never writes an `SF:` block for a test file
to `lcov.info`. Vitest has the same default. Mocha doesn't instrument
test files either because c8/nyc cover only modules loaded at runtime
(test files are entry points, not subjects).

Net effect: a `src/` directory with `calculator.ts`, `strings.ts`,
`sum.ts`, `sum.test.ts` produces a coverage report with **3 rows**, not
4. The fourth file (`sum.test.ts`) is a tool, not a subject.

## How `sum.test.ts` "covers" `sum.ts`

The linkage is **runtime, not filename-based**. When Jest runs
`sum.test.ts`:
1. Jest's module loader sees `import { sum } from './sum'` and loads
   `sum.ts`.
2. Istanbul instruments `sum.ts` at load time — every statement, branch,
   and line gets a counter.
3. `expect(sum(1, 2)).toBe(3)` executes the instrumented bytecode,
   incrementing those counters.
4. After the run, Istanbul writes a per-file dump to `lcov.info` —
   `LF:` (lines found), `LH:` (lines hit), `DA:n,k` (line `n` was hit
   `k` times). Lines with `DA:n,0` are uncovered.

`LcovParser` (`backend/src/domain/coverage/LcovParser.ts`) reads that
file and produces `FileCoverage` value objects with `linesPct = LH/LF`,
`uncoveredLines = [n where DA:n,0]`, and the same for branches and
functions. **No math is added by us beyond rounding.**

## Where this lives in the code

| Concern | File |
|---|---|
| Pick the coverage command | `backend/src/infrastructure/coverage/FrameworkDetector.ts` |
| Run install + tests in sandbox + parse lcov | `backend/src/infrastructure/coverage/NpmTestRunner.ts` |
| Parse lcov format | `backend/src/domain/coverage/LcovParser.ts` |
| Aggregate + persist a `CoverageReport` | `backend/src/application/usecases/AnalyzeRepositoryCoverage.ts` |
| Per-file VO (linesPct, hasExistingTest, etc.) | `backend/src/domain/coverage/FileCoverage.ts` |
| Threshold filter (low-coverage list) | `backend/src/domain/services/CoverageAnalyzer.ts` |
| Sibling-test detection (`hasExistingTest`) | `backend/src/infrastructure/workdir/FsSiblingTestPathFinder.ts` (port: `domain/ports/SiblingTestPathFinderPort.ts`) |

## Limits & known edge cases

| Case | Behavior |
|---|---|
| AVA / tap / uvu / Bun's test runner | `UnsupportedTestFrameworkError` at analyze time, with a friendly message listing what test-deps we *did* see |
| Mocha without c8 or nyc | `MissingMochaCoverageToolError` — "install c8 or nyc as a devDep" |
| Project's `scripts.test` wraps coverage but the wrapper outputs only non-lcov reporters (e.g. `text-summary`) | `coverage/lcov.info` won't exist → "Coverage report not produced" error from `NpmTestRunner` |
| Repo has *both* `jest` and `vitest` declared | Vitest wins (priority order). Rare in practice |
| Monorepos (nx, turbo, pnpm workspaces) | Supported via the `subpath` field on the Repository aggregate — the user provides the path to the package's `package.json` at registration. Detection then runs against that subdirectory; git operations stay at the clone root. See `Subpath` VO for the path-traversal guard. |
| Node.js built-in `node:test` runner | Not detected — its coverage flags only emit lcov on Node ≥22 with `--experimental-test-coverage --test-reporter=lcov`. Rare in OSS today |

## Inspecting the raw lcov yourself

After any analysis, the workdir is left on the host bind-mount:

```bash
grep '^SF:' /tmp/coverage-improver-jobs/<job-id>/coverage/lcov.info
# one line per source file in the report

cat /tmp/coverage-improver-jobs/<job-id>/coverage/lcov.info
# full per-file DA/LF/LH/BRF/BRH/FNF/FNH records
```

This is the same data the parser sees. If a number on the dashboard
looks wrong, this is the first place to check.

## Possible extensions (not currently implemented)

| Extension | Effort | Why we'd add it |
|---|---|---|
| **Bun (`bun test --coverage`)** | ~10 lines + lockfile case (`bun.lockb`) — Bun emits lcov natively | Increasingly common in modern TS OSS |
| **`node:test` (Node ≥22)** | Detect lack of test framework but presence of `node --test` in `scripts.test`; force `--experimental-test-coverage --test-reporter=lcov` | Rising; zero-dep test runner |
| **Coverage-config sanity check when honoring project command** | Parse `jest.config.*` / `vitest.config.*` to ensure an lcov reporter is present | Reduces "coverage report not produced" surprises |
| **Workspace auto-detection** | On registration, parse `package.json` `workspaces` / `pnpm-workspace.yaml` / `nx.json` and offer the user a picker of sub-packages instead of free-form `subpath` input | Removes a step from the monorepo onboarding flow; current `subpath` field already covers the underlying capability |

These are all framework-detection extensions; nothing downstream
(parser, persistence, UI) would need to change.
