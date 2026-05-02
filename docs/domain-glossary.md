# Domain Glossary

Concepts and terms used throughout the codebase. Where a concept lives in code, the path is given.

## Aggregates

### Repository
*Aggregate root. `backend/src/domain/repository/Repository.ts`*

A GitHub repository tracked by the system, identified by `(owner, name)`. Holds metadata that the orchestrator needs across job runs: `defaultBranch`, the `forkOwner` once a fork has been created (cached so we don't re-fork on every job), and `lastAnalyzedAt`.

Invariants:
- `owner` and `name` are non-empty, case-preserved.
- `forkOwner` is set only after `recordFork` is called.

### CoverageReport
*Aggregate. `backend/src/domain/coverage/CoverageReport.ts`*

A single coverage scan for a `Repository` at a specific commit. Composed of `FileCoverage[]`. Reports are immutable after creation; a new scan produces a new report.

Why an aggregate (vs a value object): we associate one with a specific commit SHA, persist it, and identify it by id; multiple reports per repo over time form the history.

### ImprovementJob
*Aggregate root. `backend/src/domain/job/ImprovementJob.ts`*

An attempt to improve coverage for a single file in a repository. Holds the state machine + outcome metadata.

State transitions (illegal transitions throw):
- `pending → running` via `start(coverageBefore)`
- `running → succeeded` via `succeed({ prUrl, coverageAfter, mode })`
- `running → failed` via `fail(reason)`
- `pending → failed` (used by boot-time reconciliation when the worker died)

The `mode` (`'append' | 'sibling'`) is decided by the orchestrator at runtime; it captures which path produced the final PR (helps debugging when fallback was needed).

## Value Objects

### FileCoverage
*VO. `backend/src/domain/coverage/FileCoverage.ts`*

Per-file coverage record: `path`, `linesPct`, optional `branchesPct`/`functionsPct`/`statementsPct` (lcov doesn't always carry all metrics), and the list of `uncoveredLines` (1-based). `null` for an optional metric means "not reported by the tool," not "0%".

Equality is by `path` within the enclosing `CoverageReport`.

### JobStatus / ImprovementMode
*VO. `backend/src/domain/job/JobStatus.ts`*

`JobStatus = 'pending' | 'running' | 'succeeded' | 'failed'`.
`ImprovementMode = 'append' | 'sibling'`.

## Domain Services

### CoverageAnalyzer
*Pure function. `backend/src/domain/services/CoverageAnalyzer.ts`*

Identifies files strictly below a threshold (default 80%), sorted ascending by `linesPct`. The "what counts as low coverage" rule lives here because it's a business decision, not infrastructure detail.

### JobScheduler
*Interface (impl in infrastructure). `backend/src/domain/services/JobScheduler.ts`*

Enforces the per-repository serialization invariant called out in the spec NFR. Concrete impl: `InMemoryPerRepoQueue` (a `Map<repoId, Promise>` chain).

## Ports

Interfaces in `backend/src/domain/ports/` that infra adapters implement. Application use cases depend only on these.

| Port | Implementation | Purpose |
| --- | --- | --- |
| `GitHubPort` | `OctokitGitHubAdapter` | Fork (idempotent), open PR, repo metadata |
| `GitPort` | `SimpleGitCloner` | Host-side clone + commit-and-push |
| `SandboxPort` | `DockerSandbox` | Run a command inside an isolated container with workdir mounted |
| `AICliPort` | `ClaudeCodeAdapter` | Generate test code; the "via any AI CLI" seam |
| `CoverageRunnerPort` | `NpmTestRunner` | Detect framework + run install + tests + parse lcov |
| `RepositoryRepository` | `SqliteRepositoryRepository` | Persist `Repository` aggregates |
| `CoverageReportRepository` | `SqliteCoverageReportRepository` | Persist `CoverageReport` aggregates |
| `JobRepository` | `SqliteJobRepository` | Persist `ImprovementJob` aggregates + per-job logs |

## Use Cases

Application-layer orchestrations. Each is a single class in `backend/src/application/usecases/`.

- **`RegisterRepository`** — register a GitHub URL; idempotent on `(owner, name)`.
- **`AnalyzeRepositoryCoverage`** — clone, run tests, parse lcov, persist a new `CoverageReport`. Reuses a committed `coverage/lcov.info` if present.
- **`ListLowCoverageFiles`** — read-side query backed by `CoverageAnalyzer`.
- **`ListRepositories`** — read-side query for the dashboard.
- **`RequestImprovementJob`** — validate target, persist a pending `ImprovementJob`, enqueue.
- **`RunImprovementJob`** — the orchestrator. Implements `JobExecutor`, called by the queue. Handles clone → AI → AST validate → tests → coverage delta → fork-and-PR with retry + sibling fallback.
- **`GetJobStatus` / `ListJobs`** — read-side queries.

## Cross-cutting

### AST validation
*`backend/src/infrastructure/validation/AstTestValidator.ts`*

Safety net for append-mode AI edits. Pre-AI: snapshot every `describe`/`it`/`test` (and skip/only/each variants) with its description string. Post-AI: re-parse and assert (a) every pre-existing description still present, (b) at least one new block added, (c) file still parses. Sibling-mode validation is a subset (no diff baseline, just "parses + has tests").

### Coverage-delta gate
*`backend/src/application/usecases/RunImprovementJob.ts`*

Honors the spec's "meaningful automated tests" wording. After tests pass, we re-run coverage and assert the target file's `linesPct` strictly increased from baseline. A test that runs green but doesn't exercise the targeted file fails this gate, triggering a retry.

### Sandbox isolation
*`backend/src/infrastructure/sandbox/DockerSandbox.ts`*

Each job runs in a disposable container created from `coverage-improver-sandbox:latest`. The container has `/workspace` bind-mounted to the host workdir, env vars injected at run time, and a hard runtime timeout. Default bridge networking (NAT'd, isolated from other containers); custom egress allow-listing is roadmap.

### Per-repo serialization
*`backend/src/infrastructure/queue/InMemoryPerRepoQueue.ts`*

`Map<repoId, Promise<void>>` chain — within a repo, jobs run one-at-a-time; across repos, they run concurrently. State persisted in SQLite, reconciled at boot.
