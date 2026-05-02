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

---

## Why the AI is pluggable

The spec says "via **any** AI CLI." That single word drove the whole `AICliPort` abstraction.

- **Shipped:** the Claude Code adapter — ~50 lines of code. Knows three things: which env var to require (`ANTHROPIC_API_KEY`), how to invoke `claude -p --output-format json`, and how to discover written files via `git status --porcelain` (CLI-agnostic — works for any AI tool that touches files).
- **Documented seam:** `GeminiCliAdapter.example.ts` shows the same shape with a different env var (`GEMINI_API_KEY`) and a different binary. Five-step recipe in the README to enable it for real.

A second adapter is a one-file addition. **Domain and application layers don't change.** Whatever AI CLI is adopted internally next year, this seam absorbs it.

---

## Why per-repo serialization matters

Spec NFR: *"serialize jobs per repository."* Reason:

- A repo has **one working tree** you can act on at a time. Two concurrent jobs on the same repo would race on the workdir, race on `git status`, race on lcov files.
- **Across different repos**, jobs are independent — different forks, different workdirs, different upstream PRs — so they run in parallel.

**Implementation:** a `Map<repoId, Promise<void>>` chain. Each enqueue appends to the per-repo chain → ordered execution within a repo, concurrent across repos.

**Stay-honest invariant:** state lives in SQLite. On process restart, any orphan `running` rows are reconciled to `failed` rather than pretended-into-existence.

---

## Walking the live demo

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
| "via any AI CLI" | `AICliPort` interface + adapter registry; one shipped, one example, README recipe |
| "third-party TypeScript repositories" (public + private) | Single fork-and-PR code path; PAT-driven |
| "below 80%" (configurable) | UI threshold slider, default 80, `CoverageAnalyzer` honors it |
| "minimal web dashboard using React" | Vite + React + Tailwind + shadcn-style components |
| "preparing a copy of the repository" | Per-job clone into sandbox-mounted workdir |
| "generating or enhancing the tests" | Append-to-existing primary mode; sibling-file fallback (conditional) |
| "submit ... as pull requests" | Octokit fork + push + PR with coverage-delta description |
| "run in the background" | `InMemoryPerRepoQueue` with SQLite persistence |
| "Domain, Application, Infrastructure layers" | `backend/src/{domain,application,infrastructure}/` — domain has zero framework imports |
| "framework-independent" business logic | Domain + application import only domain ports + Node `fs`/`path` — no `simple-git`, no `@octokit`, no `dockerode`, no `typescript` compiler |
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

---

## What I'd do next (genuine roadmap, not hand-waving)

These are honest follow-ups, ordered by value:

1. **Egress allow-list on the sandbox network** — custom bridge + iptables rules. Only GitHub + Anthropic API + npm registry reachable. Closes the network-policy gap noted in the README's "Documented limitations."
2. **Branch-coverage targeting** — the lcov format includes BRDA records for individual branch outcomes. We could pass uncovered *branches* (not just lines) to the AI for partially-covered files. Higher-quality test generation; uses data we already have.
3. **CI dispatch on PR open** — currently we don't trigger upstream CI; the PR's CI run depends on whether the upstream has CI configured for fork PRs. We could add a `gh workflow run` on the upstream after PR open.
4. **Mutation testing as an optional extra gate** — Stryker on the target file would prove the new tests catch real bugs, not just exercise lines. Slow (minutes), so make it opt-in per repo.
5. **Multi-process job execution** — swap `InMemoryPerRepoQueue` for a Redis-backed queue behind the same `JobScheduler` interface. Useful when you have 50 engineers all clicking Improve at once.

---

## Closing line for the interview

> *"The hard part of this challenge wasn't the integration with GitHub or the AI CLI — those are well-documented APIs. The hard part was making the AI's output trustworthy. Three independent gates, conditional fallback based on failure class, fast-fail at every stage that's cheaper than the next one — that's what makes the difference between a demo that opens a PR and a demo that opens a PR you'd actually merge."*
