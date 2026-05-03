# Defense Brief — TS Coverage Improver

A reading-order narrative for the take-home interview demo. Skip the architecture-pattern slides; this is the **business story**: what the product does, why each piece exists, and which trade-offs you can defend.

---

## The product in one sentence

> *"I run `docker compose up`, open the dashboard, paste a GitHub URL, and watch a PR appear that improves my repo's test coverage."*

That's the whole product. Everything below is implementation detail in service of that promise.

---

## The four business questions

The system answers four questions, in order. Each has to be solved before the next becomes meaningful.

### 1. "Where is coverage actually missing?"

The dashboard shows a ranked list of files with poor coverage.

**How:** we run the repo's own test suite inside a sandboxed container with coverage instrumentation turned on, parse Istanbul's `lcov.info` (the cross-tool format Jest, Vitest, Mocha+nyc, and Mocha+c8 all emit), and persist a `CoverageReport`.

The threshold is configurable — default 80% per the spec example. Lowest coverage shows first.

**Trade-off you can defend:** *Why run the tests ourselves rather than fetching from Coveralls / Codecov?*
Answer: we have to re-run the tests later anyway (to validate the AI's work — see Q2), so adding an external dependency for the *initial* scan is code with no payoff. One mechanism, used twice.

**Empty-suite handling — the "every project starts at zero" case.** A repo with no tests is a legitimate baseline (the demo target starts here), but jest/vitest exit non-zero on "no tests found" and the flow would short-circuit with a useless error. Inside the disposable workdir, `EmptySuiteHandling` plants a placeholder test so the runner exits 0, and adds coverage flags so lcov lists every source file at 0% — giving the dashboard rows the user can click Improve on. Two subtleties: (a) the per-framework `defaultTestCmd` bypasses the project's `scripts.test` entirely in this mode, because routing flags through `npm test --` is unreliable (some wrappers strip args, others have their own `--`); (b) Mocha skips the placeholder (it exits 0 on empty suites natively) and the wrapper flags get spliced *before* the `mocha` argv token so nyc/c8 actually receive them.

### 2. "Has the AI written something useful, not just something that compiles?"

This is the riskiest part of the product. The spec says "*meaningful* automated tests." An AI happily writes:

```ts
it('exists', () => { expect(thing).toBeDefined() });
```

That passes. It tells you nothing.

**How:** three independent gates that all have to be green before a PR opens:

| Gate | What it catches |
| --- | --- |
| **AST safety** (TypeScript compiler API) | AI's output corrupts existing tests — deletes an `it`, renames a `describe`, breaks the file's syntax. We reject before running anything. |
| **Tests run green** | Full suite passes inside the sandbox. Catches confident-but-wrong assertions. |
| **Coverage strictly increased** | We re-measure coverage. The *target file's* line% must actually go up. A passing test that doesn't exercise the targeted file fails this gate as useless. |

Each gate's failure feeds back into the AI's prompt as `retryFeedback` for the next attempt — same trick a human would use.

### 3. "What if the AI keeps failing?"

Failures split into two categories that need different responses:

| Class | Examples | Why it failed | Fallback strategy |
| --- | --- | --- | --- |
| **Structural** | AI broke file syntax; AI deleted an existing test | File-merge problem — AI struggling to integrate cleanly | **Write a sibling file instead** (`foo.generated.test.ts`). Fresh canvas removes the merge dimension. |
| **Behavioral** | AI added nothing new; tests fail; coverage didn't move | AI not generating *meaningful logic* | **Stop trying.** Fail honestly with logs. A fresh file won't fix the AI's output. |

This is why sibling fallback is **conditional**. We don't burn another sandbox spawn on a problem the spawn won't solve.

**Trade-off you can defend:** *Why not always fall back to sibling?*
Spawning a Docker container is expensive (network, CPU, API tokens). For behavioral failures the second sandbox produces the same useless output. Honest failure with logs > silent success masquerading as a useful PR.

### 4. "How do we get the result back to the user as a PR?"

The GitHub **fork-and-PR** flow:

1. Bot user (the PAT identity) **forks** the target repo — idempotent: if a fork already exists, reuse it.
2. Push branch `coverage-improve/<file-slug>-<job-id-short>` to the fork.
3. Open a PR from `fork:branch` → `upstream:default-branch`.
4. PR description includes the coverage delta — `42% → 91%` — so a reviewer sees the value at a glance.

**Why fork-and-PR (not direct push)?**
- Works for **public OSS repos**: the bot can fork without upstream permission.
- Works for **private/internal repos**: PAT user must have read access AND fork permission.
- One code path. Two use cases.

---

## The cheap-check-before-expensive-op design rule

A pattern that shows up everywhere in the orchestration:

> *Every expensive operation is gated by a cheap one.*

| Cheap check | Expensive operation it gates |
| --- | --- |
| `getRepositoryMeta` (one API call) | The clone (megabytes of data) |
| `existsSync(targetFile)` | Spawning a Docker container |
| Parse-check the existing test file (~10ms TS compiler call) | Spawning Docker + invoking the LLM (network, CPU, API tokens) |
| `whoami()` at boot | The first job discovering the PAT expired hours after deploy |
| `assertReady()` at boot | The first job discovering the sandbox image isn't built |

These scale from a 3-day demo to a real internal tool. Operators don't see "first improvement failed mysteriously" — they see actionable errors at startup.

---

## Why isolation matters (the security narrative)

Spec NFR: *"isolate AI CLI runs."* Two things actually need isolation:

1. **The LLM**, which we've granted file-write access to. We don't fully trust what it writes.
2. **`npm install` from a third-party repo.** Postinstall scripts are arbitrary code execution.

Both happen in a **disposable Docker container per job**:

- **Filesystem isolation:** only `/workspace` (the cloned repo) is mounted. Nothing else from the host is reachable.
- **Network isolation:** NAT'd default bridge. No access to other containers; no host filesystem.
- **Hard timeout:** container killed if it exceeds the job budget.
- **Disposable:** container destroyed on completion, success or failure.

**Roadmap (documented limitation):** custom bridge with iptables egress allow-list (only GitHub + Anthropic API + npm registry reachable). The current setup is sufficient for a 3-day demo; the egress policy is Linux-distribution-specific and outside the scope.

### Process-level vs filesystem-level isolation (honest distinction)

The OS-level guarantees above are real. But the AI container shares its `/workspace` bind-mount with the install/test containers, so a `postinstall` script can plant content (e.g., `CLAUDE.md`) that the AI later reads as project context. Two mitigations are wired into `RunImprovementJob`:

1. **Pre-AI agent-config scrubbing** (`AgentConfigScrubber.scrub`): drops `CLAUDE.md`, `.claude/`, `.cursor/`, `.aider.*`, `AGENTS.md` from the workdir before each AI invocation.
2. **Post-AI secret scanning** (`SecretScanner.findIn`): scans the AI's logs and every written file for known secret shapes (`sk-ant-…`, `ghp_…`, `github_pat_…`, `gho_/u/s/r_…`, `AKIA…`). On match, the attempt fails with `kind: 'security'` and the orchestrator halts immediately — no retry, no sibling fallback, **no push**.

Both are documented in `docs/security.md` with the threat model and an empirical-verification recipe.

---

## Why the AI is pluggable

The spec says "via **any** AI CLI." That single word drove the whole `TestGenerator` abstraction.

- **Shipped:** the Claude Code adapter — ~50 lines of code. Knows three things: which env var to require (`ANTHROPIC_API_KEY`), how to invoke `claude -p --output-format json`, and how to discover written files via `git status --porcelain` (CLI-agnostic — works for any AI tool that touches files).
- **Documented seam:** `infrastructure/ai/examples/GeminiCliTestGenerator.ts` shows the same shape with a different env var (`GEMINI_API_KEY`) and a different binary. The `examples/` directory is statically excluded from the wired registry; moving the file up one level plus a registry line enables it.

A second adapter is a one-file addition. **Domain and application layers don't change.** Whatever AI CLI is adopted internally next year, this seam absorbs it.

---

## Scalability: serialize jobs per repository

Spec NFR: *"Scalability: serialize jobs per repository."* It looks
like a serialization rule but it's really a parallelism strategy —
*serialize at the right granularity so safe concurrency is possible.*

**The rule.** Within one repo, jobs run **strictly one at a time** in
queue order. Across different repos, jobs run **fully in parallel**.

**Why this granularity.** Two simultaneous jobs on the same repo
would race on the same fork branch namespace, the same source files,
and the same coverage baseline — producing competing PRs against the
same target file. Different repos share none of that, so running them
concurrently is safe and gives free throughput.

**How we achieved it.** `InMemoryPerRepoQueue` keeps a
`Map<repoId, Promise<void>>`. Each enqueue chains a `.then(...)` onto
the previous promise for that repo, which is exactly "wait for the
last job to settle, then run mine." Different keys = independent
chains = concurrent execution. ~25 lines of code, no external
dependency, fully testable.

```ts
const prev = this.chains.get(repoId) ?? Promise.resolve();
const next = prev.catch(() => undefined).then(() => this.executor.execute(job.id));
this.chains.set(repoId, next);
```

**Complementary guard — per-file idempotency.** Per-repo serialization
queues things up; the idempotency check (`findInFlightForFile`)
prevents duplicates from queueing in the first place. A second click
on Improve for the same file while one is in flight returns
HTTP 409 (`JOB_ALREADY_IN_FLIGHT`) instead of stacking redundant
work.

**Defensive additions on top** (not required by the spec, but
production-realistic):
- Global semaphores cap simultaneous sandbox containers and AI calls
  *across* all repos (host- and account-bound limits), so 50 active
  repos don't all fan out at once.
- Admission control rejects new requests with HTTP 503 once the
  active job count hits `MAX_QUEUE_DEPTH`.

Both are documented in [`concurrency-and-backpressure.md`](./concurrency-and-backpressure.md).

**Stay-honest invariant:** state lives in SQLite. On process restart,
any orphan `running` row (one in `running` status with no live worker —
unambiguous evidence of a crash, since transitions out of `running`
only happen on a live worker) is reconciled honestly: under the
`auto_retry_count` budget it's flipped back to `pending` and
re-enqueued; over the budget it's hard-failed with
`"auto-retry budget exhausted"`. Either way, the row is never
pretended-into-existence as still running. Full mechanics in
[Reliability — crash recovery story](#reliability--crash-recovery-story)
below.

---

## Walking the live demo

Recorded happy-path backup: **https://youtu.be/LGqJd7-IKx8** — ~3 min, end-to-end against the [`jmatom/ts-coverage-demo`](https://github.com/jmatom/ts-coverage-demo) calculator repo. If the live run hits a network or PAT issue, the video covers the same beats.

Step by step, what to point at and what each step proves:

1. **`docker compose up --build`** — sandbox image builds before backend; backend boots; PAT gets validated; sandbox readiness is checked. *Proves:* boot-time validation; if anything is misconfigured you see it in 3 seconds, not 3 minutes into the demo.
2. **Add a repo** — `RegisterRepository` validates the URL, fetches metadata, persists. *Proves:* fast-fail on inaccessible / fork-disabled repos at registration time.
3. **Click Re-analyze** — clone + sandbox-isolated install + tests + lcov parse → coverage table appears. *Proves:* the analysis path with real isolation.
4. **Click Improve on a low-coverage file** — a job is queued, polled at 3s, status badges flip in real time. *Proves:* per-repo serialization, background execution, live UX.
5. **Watch the job-detail logs** — every step has a timestamp:
   - Cloning…
   - Detected framework: jest
   - Existing test file: src/foo.test.ts → starting in append mode
   - Attempt 1 (append-mode)
   - AST validation passed
   - Coverage delta: 42% → 91%
   - Pushing branch…
   - PR opened: <url>
   *Proves:* the multi-gate pipeline is visible and auditable.
6. **The PR link goes live** — clicking it lands on a real GitHub PR with a clean diff and a `42% → 91%` description. *Proves:* the whole loop closes.

---

## Where the architectural choices come from

Every architectural choice traces back to a line in the spec or a real engineering trade-off:

| Spec line | Architectural answer |
| --- | --- |
| "via any AI CLI" | `TestGenerator` interface + adapter registry; one shipped, one example, README recipe |
| "third-party TypeScript repositories" (public + private) | Single fork-and-PR code path; PAT-driven |
| "below 80%" (configurable) | UI threshold slider, default 80, `CoverageAnalyzer` honors it |
| "minimal web dashboard using React" | Vite + React + Tailwind + shadcn-style components |
| "preparing a copy of the repository" | Per-job clone into sandbox-mounted workdir |
| "generating or enhancing the tests" | Append-to-existing primary mode; sibling-file fallback (conditional) |
| "submit ... as pull requests" | Octokit fork + push + PR with coverage-delta description |
| "run in the background" | `InMemoryPerRepoQueue` with SQLite persistence |
| "Domain, Application, Infrastructure layers" | `backend/src/{domain,application,infrastructure}/` — domain has zero framework imports |
| "framework-independent" business logic | Domain + application import only domain ports + Node `fs`/`path` — no `simple-git`, no `@octokit`, no `dockerode`, no `typescript` compiler |
| "Model entities, value objects, and domain services" | One bounded context (Coverage Improvement) — single shared model, single schema, single ubiquitous language, no anti-corruption layers because there's nothing on the other side. Within it, three aggregates organized by responsibility into folders (`domain/repository/`, `domain/coverage/`, `domain/job/`) for code locality — not separate contexts. Domain services as plain pure modules (`LcovParser`, `testFileNaming`); value objects introduced *selectively* where they replace duplicated invariant checks: **`RepositoryId`** and **`JobId`** are wrapped IDs at the controller boundary, **`JobStatusValue`** owns the lifecycle transition table (replaces 4 inline status guards in `ImprovementJob`), **`CoveragePercentage`** validates the `[0, 100]` range once (replaces inline `assertPct` checks in `FileCoverage`), **`Subpath`** centralizes the path-traversal guard. Wholesale primitive-wrapping of `CommitSha` / `BranchName` deferred — diminishing returns at this scale, would dilute the meaning of the load-bearing VOs |
| "isolate AI CLI runs" | Disposable Docker container per job; FS isolation + NAT bridge + timeout |
| "secure tokens and secrets" | Tokens via env at boot only; never logged; passed to sandbox via env vars |
| "serialize jobs per repository" | `InMemoryPerRepoQueue` per-repo promise chain |
| "meaningful automated tests" | Coverage-delta gate (target file line% must strictly increase) + AST safety + tests-pass |

---

## Common questions you might get + crisp answers

**Q: Why SQLite and not Postgres?**
Spec required SQLite. Honest answer: for a single-process demo with low write rate, the operational simplicity is right. SQLite via `node:sqlite` (Node 24's built-in) — no native compile, no external service.

**Q: Why no Redis / Bull queue?**
Per-repo serialization can be enforced with an in-process promise chain (`Map<repoId, Promise>`). Job state is persisted in SQLite. Adding Redis would buy us multi-process job execution, which the spec doesn't ask for and a 3-day demo doesn't need.

**Q: What if the AI outputs an infinite loop in a test?**
Each sandbox `run` has a hard timeout — for the test phase, 10 minutes. The container is killed via `SIGKILL` and the attempt fails with exit code 124. The orchestrator then retries with feedback or fails the job honestly.

**Q: How do you handle the docker-socket-mount security trade-off?**
Documented as a known limitation. The backend mounts `/var/run/docker.sock` to spawn sandbox containers — this gives the backend container effective root on the host. Production answer: sysbox or rootless Docker-in-Docker. For a 3-day demo, the simplicity wins; the constraint is called out in the README under "Documented limitations."

**Q: What if a repo's `npm install` won't work in your sandbox?**
The job ends `failed` with logs. The README says "demo target chosen for clean install; arbitrary repos may need manual setup." Honest behavior, not silent corruption.

**Q: Why "append" rather than "rewrite the test file"?**
Append preserves existing tests verbatim — the AST validator enforces this. Rewrite would mean trusting the AI to also re-derive the existing test logic, which is a much higher bar. Sibling fallback exists for the cases where append can't merge cleanly.

**Q: How does your design handle a 100-engineer team using this?**
Two scaling axes:
1. **Multiple repos in flight**: cross-repo concurrency happens for free — different chains, different sandboxes.
2. **Multiple jobs per repo**: serialized by design — invariant comes from the spec ("serialize per repository"). If we needed multi-process job execution, swap `InMemoryPerRepoQueue` for a Redis-backed implementation behind the same `JobScheduler` interface. Domain code doesn't change.

**Q: Why a coverage-delta gate? Isn't "tests pass" enough?**
"Tests pass" doesn't prove the test exercises the file under improvement. An AI can generate a passing test with `expect(true).toBe(true)`. The coverage-delta gate is the deterministic check that the tests are meaningful — the spec word.

**Q: What if Claude writes test code that imports something not in the project's deps?**
The test run fails. That's a behavioral failure → no sibling fallback → job ends `failed` with the failed import in the logs. Honest behavior. Future improvement: feed the dep list into the AI's prompt as a constraint.

**Q: How does the domain/application layer log without importing `@nestjs/common`?**
Through a `LoggerPort` defined in `domain/ports/`, with a single Nest-backed adapter (`NestLoggerFactory`) wired in `infrastructure/`. `grep "from '@nestjs/common'" backend/src/{domain,application}` returns zero hits — the rule holds end-to-end, not just for the load-bearing ports. The honest trade-off elsewhere: I deferred wrapping `CommitSha` and `BranchName` as VOs (they're still raw `string` at the boundary). The ones that earn their keep ship — `RepositoryId` and `JobId` for IDs at the controller boundary, `JobStatusValue` for the lifecycle transition table, `CoveragePercentage` for the `[0,100]` range check, `Subpath` for path-traversal — but wrapping every git-shaped primitive at this scale would dilute those load-bearing VOs without catching a real class of bug. For a long-lived codebase with a wider team, I'd add them; for a 3-day take-home with one author, the cost/value didn't pencil out.

---

## Reliability & operational hardening (post-MVP, all shipped)

These are decisions made after the spec was satisfied, in service of "would this survive a real production touch?" Documented in `docs/concurrency-and-backpressure.md` and `docs/runtime-topology.md`.

| Concern | What's wired in |
|---|---|
| **Long-running analyze blocking HTTP** | `POST /repositories/:id/refresh` returns **HTTP 202** in <100ms; the actual clone+install+tests runs on the per-repo queue worker. Dashboard polls `analysisStatus` (`pending → running → idle/failed`). Same pattern as improvement jobs |
| **`pending` work lost on process restart** | `RecoverPendingWork` runs at `onModuleInit` after GitHub + sandbox readiness checks. Re-enqueues every `pending` row from the previous process. `running` rows are handled by a separate **bounded auto-retry** path — see "Reliability — crash recovery story" below |
| **Duplicate clicks** | `POST /jobs` returns **HTTP 409** (`JOB_ALREADY_IN_FLIGHT`) — each click is "create a new attempt for this file," so a duplicate is a real conflict. `POST /refresh` instead returns **HTTP 202** with the current repo summary even when an analysis is already in flight — a Re-analyze click expresses intent ("ensure a fresh analysis runs"), satisfied either way, so the response is no-op-success. Both are idempotent; the surfaces differ because the semantics differ |
| **Burst load saturating Anthropic / dockerd** | Two typed semaphores (`MAX_CONCURRENT_SANDBOXES=4`, `MAX_CONCURRENT_AI_CALLS=2`) enforce host-bound vs account-bound concurrency caps independently. `MAX_QUEUE_DEPTH=50` admission-control on the API side returns **HTTP 503** if the active-job count crosses it — bounded memory, predictable failure mode |
| **Event-loop blocking from in-process CPU work** | `monitorEventLoopDelay` polled at 1Hz, warns when worst-case stall ≥ 50ms. Threshold env-configurable. Hot-path `readFileSync`/`existsSync` already converted to `fs/promises` versions |
| **Monorepo support** | Optional `subpath` at registration. `Repository` aggregate validates (rejects `..` traversal). `AnalyzeRepositoryCoverage` and `RunImprovementJob` split workdir into `cloneRoot` (git ops) vs `packageRoot` (install/tests/AI). Empty subpath = repo root, single-package behavior unchanged |
| **Per-project Node version** | Sandbox image bakes Node 20 + pre-installs 18 / 22 / 24 via fnm. `NodeVersionDetector` reads `.nvmrc` → `engines.node` → falls back to baked Node 20. Each install/test sandbox call wraps `cmd` with `fnm exec --using=<major>` only when a pin was detected — projects with no pin pay zero wrapper overhead. Detection result is logged once at the start of every analysis (`Node version: 22 (detected from engines.node="^22")`) so the user can see exactly which runtime ran their tests |
| **CI on every push and PR** | `.github/workflows/ci.yml` runs Node 24 type-check (`tsc --noEmit`) + unit + non-Docker integration tests (the live `DockerSandbox` spec is skipped — it spawns real containers via `dockerode`; SQLite integration tests run against `node:sqlite`'s in-memory mode and are CI-safe). Catches regressions before review |

Each one is small (≤ ~150 LOC), surfaces through a stable env var, and has at least one unit test pinning the behavior. **281/281 tests** across 34 suites.

---

## Reliability — crash recovery story

The spec line *"resilient job handling and error recovery"* is the highest-stakes reliability bullet. Here's how the system handles a crash today, and what would change for production.

### What actually happens when the backend dies mid-job

Three failure modes converge on the same recovery path:

| Cause | Example | What it leaves behind |
|---|---|---|
| Hard kill | `kill -9`, OOMKilled, host reboot, power loss | Row(s) stuck in `running` state |
| Process panic | Unhandled rejection bubbling past Nest | Row stuck in `running` state |
| Graceful shutdown | SIGTERM during `docker compose stop` / deploys | Row drained cleanly **if** drain timer wins; otherwise `running` |

In every case, the **on-disk state is the same**: one or more rows with `status = 'running'` and no live worker.

### The invariant that makes recovery free

> *Any row in `running` state at process boot was, by definition, interrupted — because no work is allowed to be `running` while the process isn't alive.*

Every transition into `running` happens on a live worker (`ImprovementJob.start()` / `Repository.markAnalysisRunning()`); every transition out happens before the worker exits its try/catch. So a `running` row at boot is unambiguously a crash.

This is why crash recovery does **not** need a shutdown handler stamping `crashed=1`. The row's existing state is the signal. Hard kills and graceful kills are handled by the same code path. (We *do* run a graceful-shutdown drain anyway, see below — but it's a niceness, not a correctness requirement.)

### Bounded auto-retry: the implementation

At boot, `SqliteConnection.reconcileOrphanRunningJobs` (and its analyses mirror) does **two SQL passes per kind**:

1. **Auto-retry pass** — rows with `auto_retry_count < 1` are flipped back to `pending` (started_at cleared, counter incremented). `RecoverPendingWork` then picks them up the same way it picks up freshly-`pending` rows.
2. **Hard-fail pass** — rows already at the cap are marked `failed` with `"process restarted mid-execution; auto-retry budget exhausted"`. The user can manually retry from the dashboard.

The cap exists to prevent a **poison job** (one that always crashes the backend) from boot-looping the system. One free auto-retry handles the realistic cases (transient OOM, host migration, unlucky deploy timing); anything that survives that is escalated honestly.

`RunImprovementJob` logs `Resuming after process crash (auto-retry 1/1)` on the recovered run, so the user-visible job log records *why* the run started.

For analyses, the counter lives on the Repository aggregate and is **reset on `markAnalysisRequested`** — each manual re-analyze gets a fresh budget, so a repo that crashed once still benefits from auto-recovery on the next run.

### Graceful shutdown: a niceness, not load-bearing

`app.enableShutdownHooks()` plus `AppModule.onModuleDestroy`:
- HTTP listener stops accepting new requests (Nest does this before invoking the destroy hook).
- `InMemoryPerRepoQueue.waitForAllIdle()` awaits all per-repo chains.
- Capped at `SHUTDOWN_DRAIN_MS` (default 10s) — if the deadline elapses, in-flight rows stay `running` and get auto-recovered on next boot. No state divergence either way.

### Verification

- 5 dedicated SQLite tests: under-budget jobs requeued, exhausted-budget jobs failed, pending/terminal rows untouched, same coverage for analyses, `markAnalysisRequested` resets the analysis counter.
- 281/281 total tests green across 34 suites.

### What we'd do for production (and why we didn't here)

The current design is the right shape for a single-instance, in-process serialization workload. For a real production deployment, the backing queue would move out-of-process:

| Production target | Why it fits |
|---|---|
| **AWS SQS FIFO** with `MessageGroupId=<repositoryId>` | Native per-key serialization (matches our spec invariant exactly), at-least-once delivery, visibility timeout = built-in lease/heartbeat (closes the gap of detecting *hung* — not just *crashed* — workers), DLQ = direct analog of our "auto-retry budget exhausted" bucket. Workers become a stateless horizontally-scalable pool reading from the queue. |
| **Kafka topics** keyed by `repositoryId` | Better fit when throughput >> SQS limits, when we want event sourcing / replay (re-analyze the entire history), or when downstream services need to consume the same job stream. Per-key ordering via partition key. Heavier ops cost — only worth it once one of those reasons is real. |

For both, the API service stops touching SQLite for queue state — it just publishes a message. Workers consume, run the job, write the *result* to the durable store. That's the textbook decoupled architecture, and the `JobScheduler` / `RepositoryAnalysisScheduler` ports are already shaped for the swap (zero domain or application code changes — only a new infrastructure adapter).

**Why not in the take-home:** an external broker means a new container in `docker-compose.yml`, a new client lib, and the two-phase coordination problem (broker says "delivered", DB save crashes — now they disagree). That coordination is the hard part of brokers and you don't get it for free. With one backend container and SQLite already in the box, the row-as-message approach is the simplest thing that's actually correct, and the seam to upgrade is already cut. The full architectural target is laid out in the next section.

---

## Improvements for production

The current implementation is honest about its scope: a single-instance NestJS service with an in-process per-repo queue, persisting to SQLite. That shape is right for a take-home, an internal tool, or any deployment that fits on one box. For a multi-tenant production service the architecture would shift to a **decoupled command-bus + transactional-outbox pattern**.

### The shift in one line

> Today: the API process *owns* the work queue.
> Production: the API *hands off* work via the database, an outbox poller forwards it to a broker, and a separate worker pool processes it.

### How the outbox pattern works (and why it solves a real problem)

The naive design — "API writes the row, then publishes to the broker" — has a window where the DB write succeeds but the broker call fails (or vice versa). State diverges silently. The transactional-outbox pattern closes that window:

```sql
BEGIN;
  INSERT INTO improvement_jobs ... ;            -- the domain row (or repositories for analyses)
  INSERT INTO outbox (
    aggregate_type, aggregate_id, payload, status, created_at
  ) VALUES ('improvement_job', $jobId, $json, 'pending', NOW());
COMMIT;
```

Both rows land or both fail — a single SQL transaction guarantees it. No dual-write, no lost messages, no orphaned rows.

A separate **outbox poller** (cronjob or long-running worker) polls `outbox WHERE status = 'pending' ORDER BY created_at LIMIT N` every few seconds, publishes each row's payload to the broker, and **marks the row `published`** (not deleted — keep the audit trail; a separate cleanup job prunes old rows after N days). If publishing fails, the row stays `pending` and is retried on the next tick. Idempotent by construction.

```
┌─────────┐      ┌──────────────┐     ┌──────────────┐    ┌─────────┐    ┌──────────┐
│   API   │─────>│ outbox table │<────│ outbox poller│───>│  broker │───>│ workers  │
│ (write) │  TX  │  + domain    │ TX  │  (cronjob)   │    │ (queue) │    │ (consume)│
└─────────┘      └──────────────┘     └──────────────┘    └─────────┘    └──────────┘
```

### Broker choice

Three options, each fitting different scale/feature points:

| Broker | Best for |
|---|---|
| **2 × AWS SQS FIFO queues** (`repository-analysis` + `improvement-jobs`), `MessageGroupId=<repositoryId>` | Default choice. Native per-repo serialization (matches our spec invariant for free). Visibility timeout = built-in lease/heartbeat. DLQ = direct analog of our "auto-retry budget exhausted" bucket. Cheap, fully managed, scales linearly with no ops cost |
| **Kafka topics** keyed by `repositoryId` | When throughput exceeds SQS limits, when we want replay (re-analyze full history from the topic), or when downstream services need to consume the same job stream (audit, analytics, billing) |
| **RabbitMQ** with topic exchanges | When fanout to multiple consumer groups is the primary need, or in environments that already run RabbitMQ for other workloads |

For our workload, SQS FIFO is the closest fit — `MessageGroupId` IS the per-repo serialization invariant we already enforce in code. Kafka is the right answer once one of its specific advantages becomes load-bearing.

### Workers

Separate processes (containers, Lambdas, k8s pods) consume from the broker. Stateless, horizontally scalable, deployed and restarted independently of the API. Each worker:

1. Receives a message
2. Runs the job (clone → AI → validate → PR for improvements; clone → install → tests for analyses)
3. Writes the result row to the database (`improvement_jobs.status = 'succeeded'` + `pr_url`, or `coverage_reports`)
4. Acks the message back to the broker

Visibility timeout (SQS) or session timeout (Kafka consumer group) handles workers that crash mid-job — the message becomes visible again and another worker picks it up. Same effect as our current crash-recovery story, but managed by the broker instead of by our boot reconciler.

### What this buys us

| Benefit | Why it matters |
|---|---|
| **API ↔ workers decoupled** | Worker can be down for maintenance or under heavy load — API keeps accepting requests, the broker buffers them. Worker drains the backlog when it returns |
| **API restart is risk-free** | API never holds in-process queue state. Restart = zero in-flight work, zero recovery dance |
| **Workers scale independently per work-type** | If AI calls spike, scale the improvement-job worker pool. The API stays small. Scaling is by demand, not coupled |
| **Resilience to partial outages** | API down → workers keep draining backlog. Workers down → API keeps accepting work into the outbox. Either side can recover without the other |
| **Multi-region / multi-tenant ready** | Workers can be sharded geographically or by tenant. Brokers handle the routing |
| **At-least-once with idempotency** | Outbox guarantees publish; broker guarantees delivery; worker-side idempotency (we already have `ensureFork`, status-check before `start()`, the `auto_retry_count` cap) handles duplicates cleanly |

### Why not now

Three honest reasons:
1. **Scope** — a broker means a new container in `docker-compose.yml` (LocalStack to mimic SQS, or Redpanda for Kafka), a new client library, the outbox poller as its own service, and tests for the publish-or-retry semantics. ~2 days of work to do properly.
2. **The dual-write problem doesn't exist yet at this scale.** API and queue are the same process sharing the same SQLite transaction. Today's `Sqlite{Job,Repository}Repository.save()` IS the outbox-equivalent — a single atomic write that both persists state AND enqueues work for the in-process scheduler.
3. **The seam is already there.** `JobScheduler` and `RepositoryAnalysisScheduler` are domain ports. Swapping `InMemoryPerRepoQueue` for `OutboxScheduler` (writes to outbox table) + adding a separate `OutboxPoller` service is purely an infrastructure-layer change. **Zero domain or application code touched.** The cost of upgrading later is one new infra adapter + the broker setup — not a refactor of the use cases.

That last point is the architectural payoff: by treating the queue as a port from day one, we paid the small cost of port-defining today to keep the option of brokers open for tomorrow, without prematurely adopting them.

---

## What I'd do next (genuine roadmap, not hand-waving)

These are honest follow-ups, ordered by value:

1. **Egress allow-list on the sandbox network** — custom bridge + iptables rules. Only GitHub + Anthropic API + npm registry reachable. Closes the network-policy gap noted in `docs/security.md`.
2. **Branch-coverage targeting** — the lcov format includes BRDA records for individual branch outcomes. We could pass uncovered *branches* (not just lines) to the AI for partially-covered files. Higher-quality test generation; uses data we already have.
3. **Folder-tree picker on the registration form** — for monorepos, autocomplete the subpath input by querying GitHub's `git/trees?recursive=1` and filtering to directories that contain a `package.json`. ~150 LOC; covered as a future-state in the chat history.
4. **CI dispatch on PR open** — currently we don't trigger upstream CI; the PR's CI run depends on the upstream's fork-PR policy. A `gh workflow run` after PR open would close the loop.
5. **Mutation testing as an optional extra gate** — Stryker on the target file would prove the new tests catch real bugs, not just exercise lines. Slow (minutes), so opt-in per repo.
6. **Out-of-process queue with worker pool** — see ["Improvements for production"](#improvements-for-production) above for the full target architecture (transactional outbox + SQS FIFO / Kafka, workers as a stateless pool). The `JobScheduler` / `RepositoryAnalysisScheduler` ports are already shaped for the swap.

---

## Closing line for the interview

> *"The hard part of this challenge wasn't the integration with GitHub or the AI CLI — those are well-documented APIs. The hard part was making the AI's output trustworthy. Three independent gates, conditional fallback based on failure class, fast-fail at every stage that's cheaper than the next one — that's what makes the difference between a demo that opens a PR and a demo that opens a PR you'd actually merge."*
