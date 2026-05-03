# Runtime topology — who runs where, who talks to whom

This service has three persistent containers and zero or more per-job
sandbox containers spawned dynamically. The dashboard never touches the
sandbox; only the backend does. This document explains the lifecycle of
each piece, the communication channels between them, and what happens
end-to-end when a user clicks **Improve**.

## Container map

| Container | Lifetime | Owns |
|---|---|---|
| `frontend` | long-running | nginx serving the React bundle. Reverse-proxies `/api/*` to `backend:3000`. **Never talks to Docker, GitHub, SQLite, or sandbox containers.** |
| `backend` | long-running | Single owner of business logic, persistence, GitHub access, AI orchestration, sandbox spawning. |
| `sandbox` (compose service) | **build-only**, exits successfully after build | Builds the `coverage-improver-sandbox:latest` image at `docker compose up` time. The backend `depends_on: { condition: service_completed_successfully }` so the image is guaranteed present before the backend boots. The service itself does not run anything at runtime. |
| per-job sandbox container | seconds to a few minutes | Spawned by the backend via dockerode from `coverage-improver-sandbox:latest` whenever a job needs `npm install`, tests, or the AI CLI. Workdir bind-mounted at `/workspace`. Container is destroyed on completion. |

## Topology diagram

```
┌────────────┐   HTTPS    ┌──────────────────────────┐   HTTPS    ┌────────────┐
│  Browser   │──────────►│  frontend (nginx static) │──────────►│  backend   │
└────────────┘            │   serves React bundle    │           │   Nest     │
                          │   proxies /api/* ────────┼──────────►│   :3000    │
                          └──────────────────────────┘           │            │
                                                                 │            │
                                                dockerode        │            │
                                  ◄────── /var/run/docker.sock──┤            │
                                                                 │            │
                                                SQLite           │            │
                                  ◄────── /var/lib/.../db ──────┤            │
                                                                 │            │
                                                Octokit          │            │
                                  ◄────── api.github.com ───────┤            │
                                                                 └────────────┘
                                                │
                                                │ spawns + waits + destroys
                                                ▼
                              ┌───────────────────────────────┐
                              │  per-job sandbox container    │
                              │  image: coverage-improver-    │
                              │  sandbox:latest               │
                              │                               │
                              │  – cloned workdir mounted     │
                              │  – AI CLI baked in            │
                              │  – uid 1000 (node)            │
                              │  – outbound HTTPS only        │
                              └───────────────────────────────┘
```

## When the sandbox kicks in — per request

Every action goes through HTTP to the backend. The backend decides
whether sandbox spawning is required.

| User action | HTTP route | Sandbox? | Why |
|---|---|---|---|
| Add repo | `POST /repositories` | No | Octokit metadata fetch + SQLite insert |
| List repos | `GET /repositories` | No | SQLite read |
| List low-coverage files | `GET /repositories/:id/files` | No | SQLite read |
| **Re-analyze** | `POST /repositories/:id/refresh` | **Yes — 1 container** | Clone (host-side simple-git) → sandbox install + framework-specific coverage → backend reads `coverage/lcov.info` → persist |
| **Improve a file** | `POST /repositories/:id/jobs` | **Yes — 1+ containers**, async | See "Anatomy of a job" below |
| Get job status / logs | `GET /jobs/:id` | No | SQLite read |
| Delete repo / job | `DELETE /repositories/:id` etc. | No | SQLite cascade |
| Read config default | `GET /config` | No | In-memory `AppConfig` |

The HTTP request that starts an Improve job returns immediately with the
job row in `pending` state. Heavy lifting happens on a background promise
chain. Polling `GET /jobs/:id` reflects the current state.

## Anatomy of a single Improve job

The only flow that spawns multiple sandbox containers in sequence.

```
POST /repositories/:id/jobs
   │
   ▼
RequestImprovementJob (validate, fast-fail gates)
   │
   ▼
InMemoryPerRepoQueue (per-repo serialization)
   │
   ▼
RunImprovementJob.execute(job)
   │  host:  simple-git clone (no sandbox; uses backend's git binary)
   │
   ├─► sandbox container #1: install + run tests with coverage   (baseline)
   │   read coverage/lcov.info; record coverageBefore for target file
   │
   ├─► sandbox container #2: invoke AI CLI (claude -p ...)
   │   AI writes/edits *.test.ts files inside the workdir
   │
   ├─► validation gates (in-process, no sandbox):
   │     AST safety check (TypeScript compiler API)
   │
   ├─► sandbox container #3: re-run install (if needed) + tests + coverage  (validation)
   │   verify tests pass + target file's coverage strictly increased
   │
   ├─► on failure → loop back to container #2 with retryFeedback (up to 2 retries)
   │   on repeated structural failure → fall back from append → sibling mode
   │
   ├─► on success: host-side git push to bot's fork via simple-git,
   │              open PR upstream via Octokit
   │
   ▼
SQLite update: status = succeeded, prUrl, coverageBefore, coverageAfter
```

Each sandbox container is **fresh** — created, used, destroyed. They
share state only via the workdir on the host bind-mount.

## Communication channels

### Browser → frontend
HTTP over `localhost:5173`. Frontend container is just nginx serving
the built bundle. No JavaScript on the server side.

### Frontend → backend
React calls relative URLs like `/api/repositories`. nginx (in
production) and Vite's dev server (in dev) both proxy `/api/*` to
`http://backend:3000` using the compose internal DNS name. The
frontend has zero hardcoded knowledge of the backend's address.

### Backend → SQLite
In-process via `node:sqlite`. The DB file lives on a named volume
(`coverage-improver-data`) bind-mounted at
`/var/lib/coverage-improver/coverage.db`. Schema applied via
`backend/migrations/*.sql` at boot, idempotently tracked in a
`_migrations` table.

### Backend → GitHub
HTTPS via Octokit. `GITHUB_TOKEN` env var injected at boot. Used for
metadata, fork creation, branch refs, PR opening. **The sandbox
containers do not talk to GitHub** — clones happen on the host before
any sandbox spawn.

### Backend → Docker daemon (the key relationship)

`docker-compose.yml` mounts the host's Docker socket into the backend
container:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

`backend/src/infrastructure/sandbox/DockerSandbox.ts` uses dockerode
to talk to that socket. From the backend's process view it looks like
a local Docker daemon, but the daemon is the **host's**. So when the
backend asks "create a container from
`coverage-improver-sandbox:latest`", the new container is created as a
**sibling on the host**, not a child inside the backend container (no
DinD). That's why the backend bind-mounts `/tmp/coverage-improver-jobs`
under the same path inside its own container — when it asks the host
daemon to mount the workdir into a sandbox, the path needs to mean the
same thing on both sides of the socket.

This is the documented security caveat: socket-mount = the backend can
do anything the host Docker can do. Production answer is sysbox or
rootless DinD; for the take-home, the trade-off is acknowledged.

### Backend → per-job sandbox container

**Communication is only via the filesystem**. There is no RPC, socket,
or HTTP between the two:

- Backend writes the cloned repo to the host workdir.
- Backend spawns a sandbox container with that workdir bind-mounted to
  `/workspace`.
- Sandbox runs commands; backend captures stdout/stderr **post-mortem**
  via dockerode's `container.logs()` (we deliberately avoid live-attach
  to dodge a flush-deadlock bug seen on macOS Docker Desktop).
- When the sandbox writes new files (test files, `coverage/lcov.info`,
  etc.), the backend reads them off the same host path after exit.
- Container exits → backend destroys it; the workdir survives until the
  job is fully done.

Env vars are injected at container creation time via dockerode's `Env`
array — never written to disk in the workdir. See
[Security: env-var isolation](#security-env-var-isolation) below.

### Sandbox container → outside world

The sandbox has unrestricted outbound HTTPS in v1 (default Docker
bridge networking). It uses this for:

- `npm install` → `registry.npmjs.org`
- AI CLI → `api.anthropic.com` (or another endpoint per adapter)
- It **does not** clone over the network — the clone happens on the
  host and the sandbox sees the workdir already populated.

A future hardening (called out in the README) is custom-bridge plus an
egress allow-list, but it isn't shipped.

## Security: env-var isolation

The threat model: a forked or cloned target repo could contain a
malicious `package.json` with a `postinstall` script (or a Jest setup
file, or a Vitest config) that executes during the sandbox's `npm
install` / `jest` / `vitest` phase. The natural goal of such a script
is to read `process.env` and exfiltrate secrets to an attacker server.

This service mitigates that with **principle of least privilege at
each phase boundary**:

### Per-phase env injection

Sandbox containers are spawned **fresh per phase** with the env array
explicitly constructed by the backend. There is no inheritance from
the backend's own `process.env`.

| Phase | env injected |
|---|---|
| Container #1: install + test (baseline) | None of the AI / GitHub secrets. Only neutral vars (`NODE_ENV`, `CI=true`, etc.) if needed |
| Container #2: AI invoke | `ANTHROPIC_API_KEY` (or whichever the selected `AICliPort` adapter declares as `requiredEnv`) |
| Container #3: re-run install + test (validation) | Same as #1 — no AI key |

A `postinstall` script running in container #1 sees a `process.env`
that **does not contain `ANTHROPIC_API_KEY` nor `GITHUB_TOKEN`**. It
cannot exfiltrate them because they were never injected.

### Why GITHUB_TOKEN is never in the sandbox at all

Cloning happens on the **host** via simple-git, which embeds the PAT in
the HTTPS clone URL transiently. The cloned files in the workdir
contain no token references — git's standard clone behavior. The
sandbox sees the unpacked source files, never the network traffic that
delivered them, never the PAT.

Pushing the AI's branch back to the fork also happens on the host via
simple-git, after the sandbox has exited.

### Why ANTHROPIC_API_KEY is contained

The key is injected into container #2 only — the AI invocation phase.
That container's `cmd` is `claude -p ...`. No `npm install` runs in
that container; no `package.json` script executes. The malicious
target repo's `postinstall` therefore has no opportunity to run while
the key is in the environment.

If the AI itself were tricked into echoing `process.env` to the model,
the prompt machinery would still need to ship those tokens out of the
container. Claude Code's behavior is to write files to the workdir;
its prompt context does not include `process.env`. A defense-in-depth
follow-up is to filter the AI's tool-use stream for any pattern
matching `sk-ant-…` or `ghp_…` before logs are persisted, but a
malicious target repo cannot directly observe these env vars.

### Reset between containers

Every per-job sandbox container is destroyed at phase end. There is no
shared volume between containers other than the workdir bind-mount.
A `postinstall` script that writes to the workdir survives across
phases, but workdirs themselves are scoped per job and cleaned up; they
contain no secrets to begin with.

### Docker socket — out of scope here

The sandbox does **not** mount the Docker socket. Only the backend
does. So even a fully compromised sandbox container cannot escalate to
"spawn another container with my secrets in env". The blast radius of
a compromised sandbox is its own filesystem and outbound HTTPS.

### What this does not protect against

- A malicious target repo whose tests intentionally call
  `https://attacker.com/?leak=` from inside `it()` blocks. The
  sandbox's outbound network is unrestricted in v1. Custom-bridge +
  allow-list (`registry.npmjs.org`, `api.anthropic.com`,
  `api.github.com` only) is the documented next step.
- A target repo whose tests read files from `/proc` or attempt
  container escapes. The sandbox runs as `node` (uid 1000) with no
  capabilities granted, but a CVE in Docker's runtime would bypass
  this. For untrusted workloads in production, sysbox or gVisor is the
  right answer.
- Side-channel leakage via test output. If a test prints `process.env`
  on failure, the backend captures stdout/stderr. We sanitize logs in
  the dashboard? We do **not** today — a follow-up to redact known
  secret-shaped tokens in `JobLog` rows.

## Putting it together — full round-trip on Improve

```
Browser
  └─ POST /api/repositories/abc/jobs  body={ filePath: "src/sum.ts" }
        │
        ▼
Frontend nginx
  └─ proxy_pass http://backend:3000/repositories/abc/jobs
        │
        ▼
Backend Nest
  └─ RepositoriesController.createJob
       └─ RequestImprovementJob.execute  (validates, persists job row, enqueues)
       └─ returns { id, status: 'pending', ... }                     (HTTP 202)
        │
        ▼
Browser starts polling  GET /api/jobs/:id   every 3s
        │
        ▼
Backend's per-repo queue worker (background promise, not request-bound)
  └─ RunImprovementJob.execute(job)
       └─ host: simple-git clone
       └─ dockerode.createContainer → container #1 → install+test (baseline)
       └─ dockerode.createContainer → container #2 → AI invocation
       └─ AstTestSuiteValidator (in-process)
       └─ dockerode.createContainer → container #3 → re-test (validation)
       └─ Octokit: ensureFork + pushBranch + openPullRequest
       └─ SQLite: job.markSucceeded(prUrl, before, after)
        │
        ▼
Polling browser eventually sees status=succeeded and prUrl populated.
```

Three completely separate concurrency layers stacked: HTTP
request/response (sub-second), per-repo serial queue (the
orchestration), and per-job sandbox containers (each a few seconds to a
few minutes). The dashboard sees only the first; everything else is
server-side.
