# Architecture

Two views of the same system. The **system diagram** shows the
structural layering — what code lives where, what each component
owns. The **request-flow sequence** shows the temporal lifecycle of
a single Improve job — what happens, in what order, between which
participants.

For the deeper "where is each container, who talks to whom" view,
see [`runtime-topology.md`](./runtime-topology.md).

## System diagram

```mermaid
flowchart TB
    subgraph Frontend [React Dashboard]
        UI[Vite + Tailwind + shadcn-style UI]
    end

    subgraph Backend [NestJS Backend]
        direction TB
        Ctrl[HTTP Controllers]
        UC[Use Cases<br/>application/usecases/*]
        Domain[Domain Aggregates + VOs<br/>domain/*]
        Queue[InMemoryPerRepoQueue<br/>per-repo serialization]
        SQLite[(SQLite<br/>node:sqlite)]
        Ctrl --> UC
        UC --> Domain
        UC --> Queue
        Queue --> UC
        UC --> SQLite
    end

    subgraph SandboxLayer [Per-Job Sandbox Container]
        direction TB
        Claude[Claude Code CLI<br/>-p headless]
        TestRunner[npm install + jest/vitest/mocha<br/>--coverage]
        Workspace["/workspace<br/>cloned repo"]
        Claude -.writes.-> Workspace
        TestRunner -.reads.-> Workspace
    end

    subgraph External [External Systems]
        GH[GitHub<br/>Octokit + git over HTTPS]
        Anthropic[Anthropic API]
    end

    UI -- HTTP /api/* --> Ctrl
    Backend -- dockerode + /var/run/docker.sock --> SandboxLayer
    Backend -- clone, fork, push, PR --> GH
    SandboxLayer -- API calls --> Anthropic
    SandboxLayer -- npm registry, GitHub --> GH

    classDef domain fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef infra fill:#e0e7ff,stroke:#4f46e5,color:#312e81
    classDef ext fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class Domain,UC domain
    class Ctrl,Queue,SQLite infra
    class GH,Anthropic ext
```

The yellow nodes (`Domain`, `Use Cases`) contain **zero** NestJS or
concrete-library imports. Only the purple infrastructure nodes import
NestJS, Octokit, dockerode, simple-git, the TS compiler API, and
`node:sqlite`. Cross-layer calls go through ports (interfaces in
`domain/ports/`).

## Analyze-flow sequence

A single Re-analyze request from click to coverage table populated.
Same three concurrency layers as the Improve flow below: HTTP
request/response (sub-second), the per-repo queue (background promise
chain that runs the clone + install + tests), and a per-analyze
sandbox container.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Browser as Browser<br/>(React)
    participant Backend as Backend<br/>(NestJS)
    participant GitHub
    participant Sandbox as Sandbox<br/>(Docker container)

    User->>Browser: Click "Re-analyze"
    Browser->>Backend: POST /api/repositories/:id/refresh
    Backend->>Backend: validate (repo exists)
    Backend->>Backend: idempotency check (already pending/running? → return current state)
    Backend->>Backend: mark repo pending, persist, enqueue on per-repo queue
    Backend-->>Browser: 202 { analysisStatus: "pending", ... }
    Note over Browser: Polls /api/repositories every 3s

    Note over Backend: --- background promise chain ---
    Backend->>Backend: mark repo running, persist

    Backend->>GitHub: clone default branch into cloneRoot<br/>(host-side simple-git, PAT in URL — whole repo, not subpath-scoped)
    GitHub-->>Backend: source files into cloneRoot
    Backend->>Backend: resolve packageRoot = cloneRoot joined with repo.subpath (if set)<br/>(scopes install + tests for monorepos; git ops stay at cloneRoot)

    Backend->>Sandbox: spawn (workdir = packageRoot) — detect framework (jest/vitest/mocha+c8/nyc),<br/>npm install, run tests with coverage
    Sandbox-->>Backend: coverage/lcov.info

    Backend->>Backend: LcovParser.parse(lcov.info) → FileCoverage list
    Backend->>Backend: per-file sibling-test probe<br/>(enrich hasExistingTest, parallel via Promise.all)
    Backend->>Backend: CoverageReport.create + persist (per-commit-SHA row)
    Backend->>Backend: mark repo idle, set lastAnalyzedAt

    Browser->>Backend: GET /api/repositories (next poll)
    Backend-->>Browser: { analysisStatus: "idle", overallLinesPct, fileCount }
    User->>Browser: Click into repo → coverage table renders
```

A few callouts on the analyze sequence:

- The HTTP response (step 6) returns *before* the clone starts. Same
  pattern as the Improve flow — clone + install + tests can take
  minutes for a real-world repo, and the dashboard observes the
  transitions via polling rather than a long-held connection.
- The per-repo queue serializes analysis against any improvement jobs
  for the same repo (both contend for the cloned workdir). Different
  repos run concurrently.
- Repository registration (`POST /api/repositories`) doesn't run
  analysis automatically; the user clicks Re-analyze when ready. This
  keeps registration latency predictable and avoids surprise sandbox
  spawns.
- On any thrown exception during the background chain, the repo
  transitions to `analysisStatus: "failed"` with the error message
  surfaced via `analysisError`. The boot reconciler resurrects rows
  stuck in `running` after a backend crash (one auto-retry, then
  hard-fail — see [`concurrency-and-backpressure.md`](./concurrency-and-backpressure.md)).
- `CoverageReport` rows are immutable and tagged with `(repositoryId, commitSha)` —
  re-analyzing the same commit produces a new row rather than mutating
  the previous one (the schema's primary key is the report's UUID, not
  the pair). The dashboard always reads the latest by `generated_at`.

## Improvement-job sequence

A single Improve job from click to merged PR. Three concurrency
layers are visible: HTTP request/response (sub-second), the
backend's per-repo queue (background promise chain that survives the
HTTP response), and per-job sandbox containers (each its own Linux
process).

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Browser as Browser<br/>(React)
    participant Backend as Backend<br/>(NestJS)
    participant GitHub
    participant Sandbox as Sandbox<br/>(Docker container)
    participant AI as AI CLI<br/>(Claude)

    User->>Browser: Click "Improve"
    Browser->>Backend: POST /api/repositories/:id/jobs
    Backend->>Backend: validate (file in report, < 100%, not in flight, queue depth OK)
    Backend->>Backend: persist job (status=pending) + enqueue
    Backend-->>Browser: 202 { id, status: "pending" }
    Note over Browser: Polls /api/jobs/:id every 3s

    Note over Backend: --- background promise chain ---
    Backend->>GitHub: clone (host-side simple-git, PAT in URL)
    GitHub-->>Backend: source files into per-job workdir
    Backend->>Backend: agentConfigScrubber.scrub() — drop CLAUDE.md, .cursor/, etc.

    Backend->>Sandbox: spawn #1 — install + jest --coverage<br/>(env: none of the secrets)
    Sandbox-->>Backend: coverage/lcov.info → coverageBefore

    Backend->>Sandbox: spawn #2 — claude -p<br/>(env: ANTHROPIC_API_KEY only)
    Sandbox->>AI: prompt + tool use
    AI-->>Sandbox: written *.test.ts files
    Sandbox-->>Backend: writtenFiles + logs

    Backend->>Backend: AST validate (TS compiler API)
    Backend->>Backend: secret-leak scan (sk-ant-*, ghp_*, …)

    Backend->>Sandbox: spawn #3 — re-run install + tests<br/>(validation)
    Sandbox-->>Backend: new lcov → coverageAfter
    Backend->>Backend: assert coverageAfter > coverageBefore

    Backend->>GitHub: ensureFork → push branch → open PR
    GitHub-->>Backend: prUrl
    Backend->>Backend: persist status=succeeded, prUrl, deltas

    Browser->>Backend: GET /api/jobs/:id (next poll)
    Backend-->>Browser: { status: "succeeded", prUrl }
    User->>Browser: Click "Visit PR"
```

A few callouts on the sequence:

- The HTTP response (step 5) returns *before* any sandbox work
  starts. The dashboard sees only HTTP; everything else is server-side
  promise-chain work.
- Each `spawn #N` is a **fresh** Docker container — `createContainer`
  → `start` → `wait` → `remove`. They share only the workdir
  bind-mount, not memory or env. The attacker's `postinstall` (in
  spawn #1) cannot read `ANTHROPIC_API_KEY` because that var is only
  injected into spawn #2's env array.
- The pre-AI `agentConfigScrubber.scrub()` and the post-AI `SecretScanner.findIn()`
  are the prompt-injection defenses described in
  [`security.md`](./security.md).
- On AST or test or coverage-delta failure, the loop retries (up to 2
  attempts per mode) with the failure reason fed back into the next
  prompt. On structural failure, append-mode falls back to
  sibling-mode. On security failure, the loop halts immediately.
- The "ensureFork → push → open PR" step uses Octokit on the host —
  no sandbox involvement.

## Source for the diagrams

- [`architecture.mmd`](./architecture.mmd) — the system flowchart
  above, in a standalone `.mmd` file for `mermaid-cli` rendering.
- The two sequence diagram sources are the ` ```mermaid sequenceDiagram ` blocks above
  (analyze flow, then improvement-job flow).
