# Concurrency & backpressure

Three independent concurrency layers stack inside the backend. The
admission control + capacity caps documented here exist to keep them
healthy under burst load. This document is also the defense for why the
specific structure was chosen instead of a single `MAX_CONCURRENT_JOBS`
knob or worker threads.

## The three layers

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: HTTP request handling (Nest, fastify-style event loop) │
│   – sub-second                                                  │
│   – Layer-1 concurrency = browser polling cadence × users       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: Per-repo serial queue (InMemoryPerRepoQueue)           │
│   – seconds to minutes per job                                  │
│   – Layer-2 concurrency = (# repos with active work)            │
│   – within a repo: strictly serial (spec NFR)                   │
│   – across repos: independent promise chains, fully concurrent  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: Per-job sandbox containers + AI calls                  │
│   – seconds to minutes per phase                                │
│   – capped by typed semaphores                                  │
│     · sandbox-slots cap (host-bound)                            │
│     · ai-slots cap (account-bound)                              │
└─────────────────────────────────────────────────────────────────┘
```

The dashboard sees only Layer 1. Everything else is server-side.

## Why uncapped fan-out hurts (the problem)

Without the caps below, 30 repos each receiving a "queue every low-
coverage file" command at once would attempt to spawn 30+ sandbox
containers simultaneously. The damage is multi-axis:

| Axis | Failure mode |
|---|---|
| Memory | Each `npm install` is 200–500 MB resident. 30 × parallel = OOM |
| Disk | Each clone is 10–100 MB. Disk fills, npm caches thrash |
| Anthropic rate limits | ~50 RPM/key default tier; saturated within seconds, jobs fail mid-attempt |
| Anthropic credit cost | 30 × ~$0.10 = ~$3 in 60 seconds. One misclick = real cost incident |
| Docker daemon | Sustains ~10–20 simultaneous spawns; beyond, the API gets sluggish — unrelated `docker ps` calls time out |
| GitHub API | Octokit calls per job are small, but at 30× concurrency you hit secondary rate limits (especially fork creation) |

These failure modes have **different shapes**. That's why a single
generic `MAX_CONCURRENT_JOBS` knob would be a poor fit — it conflates
host-bound limits with account-bound limits.

## Solution shape: typed semaphores + admission control

### Semaphores (Layer 3 — capacity control)

Two distinct semaphores stacked, each guarding a different resource:

| Semaphore | Default cap | Reason | Env var |
|---|---|---|---|
| Sandbox slots | 4 | Host-bound (RAM, disk, dockerd) | `MAX_CONCURRENT_SANDBOXES` |
| AI slots | 2 | Account-bound (Anthropic RPM, credit cost) | `MAX_CONCURRENT_AI_CALLS` |

Implementation:

- `Semaphore` is a 30-line FIFO async counting semaphore. `acquire()`
  resolves with a `release` fn once a slot is free.
- `SemaphoreSandbox` is a thin decorator over `SandboxPort` that gates
  every `run()` through the sandbox semaphore. `assertReady()` is **not**
  gated — it's a fast health check, gating it would block boot validation
  behind in-flight jobs.
- `SemaphoreAiAdapter` is the analogous decorator over `AICliPort`,
  gating `generateTest()` only.

The wrappers are wired in `app.module.ts`:

```ts
provide: TOKENS.SandboxPort,
useFactory: (config) => new SemaphoreSandbox(
  new DockerSandbox({ image: config.sandboxImage, … }),
  new Semaphore(config.maxConcurrentSandboxes),
),

provide: TOKENS.AICliPort,
useFactory: (config, sandbox) => new SemaphoreAiAdapter(
  selectAiAdapter(config.aiCli, sandbox, config.rawEnv),
  new Semaphore(config.maxConcurrentAiCalls),
),
```

How the two semaphores stack:

- Each `sandbox.run()` call (install, test, or AI) acquires a
  **sandbox** slot for its duration and releases it on exit. Slots are
  held per-call, not per-job — between the install-call and the
  test-call inside `NpmTestRunner.run()`, the slot is briefly free.
- AI invocations additionally acquire an **AI** slot. The path is
  `SemaphoreAiAdapter.generateTest` (acquires AI) → `ClaudeCodeAdapter.
  generateTest` → `this.sandbox.run(...)` → `SemaphoreSandbox.run`
  (acquires sandbox). So an AI call holds **both** slots for its full
  duration. That is the intended behavior: the AI call is itself a
  sandbox container, so it must contribute to the host-bound count.
- The independence of the two caps comes from the relative magnitude.
  With `MAX_CONCURRENT_SANDBOXES=4` and `MAX_CONCURRENT_AI_CALLS=2`, AI
  invocations are limited to 2 (account-bound) but install/test work
  for *other* jobs can still use the remaining 2 sandbox slots while
  the AI is busy. Without the AI cap, all 4 sandbox slots could be
  filled with AI calls and saturate the API rate limit.

No deadlock risk: semaphores are acquired in a consistent order (AI
first, then sandbox in the same call chain). Non-AI sandbox work
doesn't touch the AI semaphore at all, so a circular wait can't form.

**Why decorators instead of pushing into the use case**: keeps
`RunImprovementJob` blissfully unaware of capacity; testable as if no
caps exist; switching to a no-op semaphore in tests is a one-line
override. Application layer remains free of infrastructure concerns.

### Admission control (Layer 1→2 boundary)

Even with capacity caps in Layer 3, an unbounded queue at Layer 2 is a
liability: enqueueing 1000 jobs holds 1000 `ImprovementJob` records in
memory and 1000 promise-chain entries while they wait. So we add a
request-time gate:

- `MAX_QUEUE_DEPTH` (default 50): max active (pending+running) jobs
  across the whole system.
- Beyond that, `RequestImprovementJob.execute(...)` throws
  `QueueDepthExceededError`, which the `DomainExceptionFilter` maps to
  **HTTP 503**.
- The dashboard's existing error banner surfaces this as a friendly
  "system busy" message; clients can also use the stable
  `code: "QUEUE_DEPTH_EXCEEDED"` for retry logic.

The check uses `JobRepository.countActive()` — a single
`SELECT COUNT(*) … WHERE status IN ('pending','running')` against
SQLite, micro-second cost per request. The check runs **after** the
per-file idempotency guard, so retrying the same file when one is
already in flight returns 409 (clearer signal) rather than 503.

`MAX_QUEUE_DEPTH=0` disables the cap (testing only).

### Defense-in-depth: per-repo serialization stays untouched

The existing per-repo serial queue is **not** weakened by these
additions. Within a single repo, jobs still run strictly sequentially
— required because two simultaneous improvements on the same repo
would race on the workdir, the fork branch, and potentially produce
duplicate PRs. The semaphores constrain concurrency *across* repos
without affecting per-repo ordering.

## Why not worker threads?

This question came up. Worker threads pay off when **the event loop is
being blocked by CPU-bound work**. An audit of where backend CPU
actually goes during a typical job:

| Work | Where it runs | Loop-blocking? |
|---|---|---|
| `git clone` | host process via simple-git, but git itself is a subprocess | No |
| `npm install` | inside sandbox container | No |
| `jest --coverage` | inside sandbox container | No |
| `claude -p ...` | inside sandbox container | No |
| Octokit calls | backend, network I/O | No |
| Dockerode RPC over the socket | backend, network I/O | No |
| `LcovParser.parse(...)` | backend, in-process | Yes, but typically <5 ms |
| `AstTestValidator` (TS compiler API) | backend, in-process | Yes, ~10–50 ms per test file |
| `node:sqlite` reads/writes | backend, sync | Yes, sub-millisecond per call |
| `existsSync`, `readFileSync` | backend, sync | Yes, sub-millisecond |

The expensive work — install, tests, AI — already runs in **separate
processes** (sandbox containers). The backend's job during those phases
is to await a docker container exit, which is pure I/O. Worker threads
add complexity (transferable types, message passing, lifecycle) for a
payoff that doesn't exist yet.

The cheaper first wins, taken in this same change set:

1. Convert hot-path `readFileSync` / `existsSync` to `fs/promises`
   variants — eliminates the few sync stalls that did exist.
2. Add `monitorEventLoopDelay` with a warning log on stalls ≥ 50 ms —
   gives data-driven evidence if/when worker threads become
   warranted.

If the event-loop monitor starts firing under realistic load, the right
follow-up is to extract just `AstTestValidator` and `LcovParser` (both
pure functions) onto a small worker pool. The architecture is friendly
to that retrofit because both functions are testable in isolation.

## Configuration matrix

| Variable | Default | Range | Effect |
|---|---|---|---|
| `MAX_CONCURRENT_SANDBOXES` | 4 | ≥ 1 | Cap on simultaneous Docker container spawns. Raise on big hosts; lower on laptops |
| `MAX_CONCURRENT_AI_CALLS` | 2 | ≥ 1 | Cap on simultaneous AI invocations. Tied to your API key's rate-limit tier |
| `MAX_QUEUE_DEPTH` | 50 | ≥ 0 | Max active (pending+running) jobs system-wide. 0 disables admission control |
| `EVENT_LOOP_STALL_THRESHOLD_MS` | 50 | ≥ 1 | Warn-log threshold for worst-case event-loop delay |

All four are validated at boot (`AppConfig.loadAppConfig`). Bogus values
fail-fast with a clear error rather than degrading silently at runtime.

## Observability

Boot logs include the configured caps:

```
[Concurrency]   Sandbox concurrency cap: 4
[Concurrency]   AI concurrency cap: 2
[EventLoopMonitor] Event loop monitor started — warn on stalls ≥ 50ms (poll 1000ms, resolution 10ms)
```

Stall warnings look like:

```
[EventLoopMonitor] Event loop stalled: max=72.4ms p99=68.1ms mean=4.12ms (threshold=50ms, window=1000ms)
```

Two complementary signals: caps tell you the *intended* capacity,
stalls tell you whether the work is fitting inside the loop's budget.

## Crash recovery on boot

The in-memory promise chains die with the process; the SQLite rows
survive. Boot reconciles this in two steps:

1. **Orphan `running` rows** (improvement jobs and analyses) are handled
   inline in the `SqliteConnection` provider factory by
   `reconcileOrphanRunningJobs` / `reconcileOrphanRunningAnalyses`. By
   definition, any row still `running` at boot was interrupted —
   there's no worker holding it. The reconciler either auto-retries it
   once (resets to `pending`, bumps `auto_retry_count`) or hard-fails
   it once the budget is exhausted. The cap of 1 prevents a poison job
   from boot-looping the backend.
2. **Pending rows** (jobs and analyses) are re-enqueued by
   `RecoverPendingWork`, invoked from `AppModule.onModuleInit` after
   the GitHub + sandbox readiness checks pass. These rows never started
   running, so the right action is to actually run them. Re-enqueue
   bypasses `RequestImprovementJob`'s admission control (queue-depth
   cap, idempotency guard) — these jobs were already admitted before
   the restart, double-charging them would be wrong.

The two steps are ordered by Nest's lifecycle: the SQLite provider
factory runs at module construction, before `onModuleInit` fires, so
`running` → `pending` transitions from step 1 are visible to step 2's
`findByStatus('pending')` query.

## What's deliberately not implemented

- **Per-repo fairness.** If 5 repos each enqueue 3 jobs and the cap is
  2, repo #1 currently wins both slots, then again on the next round,
  starving the others. Round-robin scheduling across repos is a
  follow-up; FIFO is acceptable for the take-home.
- **Distributed concurrency control.** Single-node only. A multi-node
  deployment would need shared state for the semaphores (Redis,
  Postgres advisory locks, etc.). The current architecture targets a
  single backend pod, which is realistic for the assignment scope.
- **Worker threads.** See "Why not worker threads?" above. Reserved
  for when the event-loop monitor justifies it.
