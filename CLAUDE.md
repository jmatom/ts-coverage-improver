# Project context for Claude Code

> Auto-loaded by Claude Code at session start. Source of truth for
> project-specific conventions. Read top to bottom on first onboard;
> consult sections by name once familiar. The **Project conventions**
> section below is the load-bearing part — those are the rules that
> aren't obvious from any single file.

## What this is

**TS Coverage Improver** — a NestJS service with a React dashboard that
analyzes a GitHub repository's TypeScript test coverage, runs an AI CLI
inside a sandboxed Docker container to write missing tests against
low-coverage files, validates the AI's output through three gates
(AST-shape preservation, tests pass, coverage strictly increases), and
opens a fork-and-PR upstream with the coverage delta in the description.

## Stack

- **Backend**: NestJS, Node 24, `node:sqlite` (built-in, no native deps),
  strict DDD layering. Domain + application have **zero** framework imports.
- **Frontend**: Vite + React + Tailwind + shadcn-style components (custom-built,
  no shadcn CLI). Radix primitives for Dialog/Tooltip/DropdownMenu.
- **Sandbox**: per-job Docker container from a pre-built image with the
  Claude Code CLI, runs as `node` (uid 1000), `git config safe.directory '*'`
  baked in. Spawned via `dockerode` from the backend.
- **Persistence**: SQLite via Node's built-in `node:sqlite`. Schema lives in
  `backend/migrations/*.sql`. Foreign-key cascades drop dependent rows on
  repository delete.

## Layout

```
ts-coverage-improver/
├── backend/                           NestJS, DDD-layered
│   ├── src/
│   │   ├── domain/                    Plain TS — entities, VOs, ports, errors
│   │   ├── application/               Use cases — depend only on ports
│   │   └── infrastructure/            Octokit, dockerode, simple-git, TS compiler,
│   │                                  SQLite, NestJS controllers + DI
│   ├── migrations/
│   ├── test/{unit,integration}/
│   └── Dockerfile                     node:24-slim, multi-stage
├── frontend/                          Vite + React
│   ├── src/{pages,components,api,lib}/
│   └── Dockerfile                     nginx static
├── sandbox/Dockerfile                 node:20-slim + git + Claude CLI, USER node
├── docker-compose.yml
├── .env.example                       GITHUB_TOKEN + ANTHROPIC_API_KEY required
├── docs/                              architecture.md, security.md, defense.md, …
└── CLAUDE.md                          this file
```

## How to run

```bash
cp .env.example .env
# fill GITHUB_TOKEN (fine-grained PAT with Contents/PullRequests/Administration:r+w
#   OR classic PAT with `repo` scope for forking arbitrary OSS)
# fill ANTHROPIC_API_KEY (for Claude Code inside the sandbox)

docker compose up --build
# Backend  :3000
# Frontend :5173
```

## How to test

```bash
cd backend
npm test                                # full suite (includes live DockerSandbox integration)
npm test -- --testPathPattern='unit'    # unit-only (skips DockerSandbox; what CI runs)
npx tsc --noEmit                        # type-check
```

## Project conventions

These are the load-bearing rules that aren't obvious from reading any single
file. Follow them.

### DDD strict layering

`backend/src/domain/` and `backend/src/application/` must import **zero**
NestJS, Octokit, dockerode, simple-git, TS compiler, or `node:sqlite`. They
are plain TypeScript. Cross-layer calls go through ports defined in
`domain/ports/`; only `infrastructure/` imports framework code or concrete
deps. Use cases are registered as Nest providers via `useFactory` in
`infrastructure/nest/app.module.ts` — no `@Injectable()` on use cases or
domain services.

### Port and adapter naming

- **Port name describes a *capability***, not a delivery mechanism. E.g.
  `TestGenerator` (capability), not `AICliPort` (which would lock the port
  to one delivery mode). `CoverageRunnerPort`, `SandboxPort`,
  `TestSuiteValidatorPort` follow the same rule.
- **Adapter name is `${tech-prefix}${port-name-minus-Port}`**. To find the
  adapter for any port: drop "Port" from the port name, prepend the tech.
  Examples:
  - `RepositoryRepository` → `SqliteRepositoryRepository`
  - `GitHubPort` → `OctokitGitHub`
  - `GitPort` → `SimpleGit`
  - `SandboxPort` → `DockerSandbox`
  - `CoverageRunnerPort` → `NpmCoverageRunner`
  - `TestSuiteValidatorPort` → `AstTestSuiteValidator`
  - `AgentConfigScrubberPort` → `FsAgentConfigScrubber`
  - `TestGenerator` → `ClaudeCliTestGenerator`
- **Acronyms in identifiers: PascalCase as words.** Prefer `Ai` over `AI`
  in identifier names (e.g. `SemaphoreAiAdapter`, not `SemaphoreAIAdapter`).
- **Non-wired example sketches live under `infrastructure/<area>/examples/`.**
  The registry never imports from `examples/`, so the directory name acts
  as static exclusion. See `infrastructure/ai/examples/GeminiCliTestGenerator.ts`.

### Value objects and domain errors

- **IDs are typed VOs at the controller boundary.** `RepositoryId`, `JobId`,
  `CoverageThreshold` get constructed from raw HTTP path/query params via
  `.of(raw)` in the controller; use cases and ports consume the typed VO
  end-to-end; SQLite adapters unwrap `.value` on write and re-wrap on
  rehydration.
- **Two distinct error classes for boundary vs invariant.** Boundary VOs
  (`RepositoryId.of`, `JobId.of`, `CoverageThreshold.of`) throw
  `InvalidRepositoryIdError` / `InvalidJobIdError` /
  `InvalidCoverageThresholdError` — these map to **HTTP 400** (client
  malformed input). Internal invariants throw `DomainInvariantError` — maps
  to **HTTP 500** (programmer bug, not user-recoverable). The
  `DomainExceptionFilter` defaults unmapped codes to 500, not 422.

### HTTP status semantics

- **202** for every mutating endpoint that produces async work (or whose
  success state is not a fully-realized resource): `POST /repositories`,
  `POST /repositories/:id/refresh`, `POST /repositories/:id/jobs`. The
  controller is consistent on this — no `201`s.
- **204** for `DELETE` endpoints (idempotent, no response body).
- Each handler has a one-line comment listing its success status and the
  domain error codes that can flow back through `DomainExceptionFilter`.
  Keep this updated when you add a failure mode.

### Concurrency

- **Per-repo serial queue.** The same `InMemoryPerRepoQueue` instance is
  registered under both `TOKENS.JobScheduler` and
  `TOKENS.RepositoryAnalysisScheduler` (via `useExisting`) so that for a
  given `repositoryId`, analyses and improvement jobs run sequentially
  against each other. The queue keys its `Map<string, Promise>` by
  `repositoryId.value` (string), not the VO instance — Map equality is
  by reference, so VO instances would not collapse to the same key.
- **No concurrent writers per repo.** Use cases assume single-writer
  semantics for their target repo. This is enforced by the queue, not by
  optimistic locking. If you ever go multi-node, switch to a `version`
  column with optimistic-lock retries — see
  `docs/concurrency-and-backpressure.md`.
- **`auto_retry_count` cap = 1.** Boot reconciler resurrects orphan
  `running` rows once; a row that fails twice is hard-failed to prevent
  poison-job boot loops. Documented trade-off: in rapid-restart scenarios,
  innocent jobs can be falsely marked failed. SQS-style visibility
  timeouts are the proper fix when this matters.

### Mermaid sequence diagrams

When editing diagrams in `docs/architecture.md`, the parser will choke on:

- **Semicolons in message text** — `;` is a statement separator in
  sequenceDiagram. Use `,` or split into separate messages.
- **Square brackets in message text** — `[` after a token gets interpreted
  as the start of an inline alias. Reword without `[...]`.

Validate locally before pushing:

```bash
awk -f /tmp/split.awk docs/architecture.md  # extracts the four blocks
for f in /tmp/diag*.mmd; do
  npx --yes -p @mermaid-js/mermaid-cli mmdc -i "$f" -o "${f%.mmd}.svg"
done
```

### Tests and PRs

- **Tests use plain-class fakes**, not `Test.createTestingModule`. The
  use cases are constructor-injected, so unit tests instantiate them
  directly with stub adapters. Token-based DI in `app.module.ts` is what
  makes this easy.
- **Branch off `main`, push, open a PR.** Direct push to `main` is blocked
  by branch protection. Squash-merge style is fine.

## Where to look

- `docs/architecture.md` — system flowchart + three sequence diagrams
  (register → analyze → improve)
- `docs/concurrency-and-backpressure.md` — per-repo queue, semaphores,
  crash recovery on boot
- `docs/security.md` — sandbox isolation, secret scanner, env injection
  per phase
- `docs/coverage-detection.md` — framework detection + lcov parser
  trade-offs
- `docs/runtime-topology.md` — container layout, port allocation, egress
  allowlist
- `docs/domain-glossary.md` — every aggregate, VO, port, adapter explained
  with one-line purpose
- `docs/defense.md` — narrated reading order for the demo
