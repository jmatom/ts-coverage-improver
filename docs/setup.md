# Setup details

The README's Quickstart covers the happy path (Docker Desktop + two
secrets). This document expands on the parts that don't fit there:
PAT scope choices, Anthropic API key, local dev without Docker, and
the verification commands that catch misconfigurations early.

## GitHub PAT — required for every repo, not just private ones

GitHub doesn't allow anonymous forks, branch pushes, or PR creation
even on public repositories — so the bot needs a token regardless of
the target repo's visibility. The token is the bot's identity for the
entire fork-and-PR flow.

Two paths, pick one based on what you'll target:

### Fine-grained PAT (preferred when targeting your own repos)

GitHub Settings → **Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**.

- **Resource owner:** your personal account (or an org you administer).
- **Repository access:** **All repositories** is simplest. **Selected
  repositories** works if every demo target is one you can administer.
- **Repository permissions** (set these; leave the rest at *No access*):
  - `Contents` → **Read and write** — clone, branch, push.
  - `Pull requests` → **Read and write** — open the PR upstream.
  - `Administration` → **Read and write** — required to create forks
    via API.
  - `Metadata` → **Read** (auto-set; can't disable).
  - `Workflows` → **No access** — we never touch `.github/workflows/*`.
- **Account permissions:** all **No access**.

> **Caveat for arbitrary OSS targets:** fine-grained PATs can only
> fork repos under accounts/orgs the token has admin access to.
> Forking a third-party public OSS repo (e.g. `sindresorhus/is`,
> `lukeed/clsx`) where you don't own the upstream requires a classic
> PAT instead. For an *internal-repos* use case, fine-grained with
> the perms above is the right answer.

### Classic PAT (simpler when forking arbitrary public OSS)

GitHub Settings → **Developer settings → Personal access tokens
(classic) → Generate new token (classic)**.

- ✅ **`repo`** — full control of private repos. Covers clone (private
  + public), fork, push, open PR. **This single scope is enough.**
- ❌ `workflow` — *not needed.* We only write `*.test.ts` files.
- ❌ everything else — leave unchecked.

### Verify the token before starting the stack

```bash
# 1. Token validity. Should print your GitHub login.
curl -sH "Authorization: Bearer <TOKEN>" https://api.github.com/user | jq '.login'

# 2. Fork capability against the repo you intend to demo. Should
# print full_name + html_url. If you see "Resource not accessible by
# personal access token", the token can't fork that target — switch
# to a classic PAT, or pick a target you administer.
curl -sX POST -H "Authorization: Bearer <TOKEN>" \
  https://api.github.com/repos/<owner>/<repo>/forks | \
  jq '{full_name, html_url, message}'
```

The backend itself runs the equivalent of (1) at boot — see
`AppModule.onModuleInit` — and refuses to start if the token is
invalid. So if the stack boots, you've already passed (1).

## Anthropic API key

[console.anthropic.com](https://console.anthropic.com/) → **API
keys** → **Create key**. Format `sk-ant-api03-…`. Place it in `.env`
as `ANTHROPIC_API_KEY=…`.

A few minutes' worth of demo use costs ~$0.10 in credits at typical
prompt sizes. Set up billing in advance — Anthropic's "create key"
flow does not auto-prompt for it, and the first call will fail with
"insufficient credit" if you skip the billing step.

## Public vs private target repos

The fork-and-PR flow handles both cleanly:

- **Public**: PAT user forks (no upstream perms needed) → pushes to
  fork → opens PR upstream.
- **Private**: PAT user must have read access AND the repo must allow
  forking. If forking is disabled at the org level, the job ends
  `failed` with a clear `FORKING_DISABLED` error.

## Local dev without Docker

The whole stack also runs without `docker compose` (faster
iteration). You'll still need the host Docker daemon running, since
the backend spawns sandbox containers via the socket regardless of
where the backend itself runs.

```bash
# One-time: build the sandbox image once so spawned containers find it.
docker build -t coverage-improver-sandbox:latest sandbox/

# Backend (terminal 1)
cd backend
npm install
cp .env.example .env  # fill GITHUB_TOKEN + ANTHROPIC_API_KEY
npm run start:dev      # watches src/, restarts on change

# Frontend (terminal 2)
cd frontend
npm install
npm run dev            # Vite dev server, proxies /api/* to :3000
```

Vite dev server is at http://localhost:5173. Backend at
http://localhost:3000.

## Boot validation — what to expect

Successful backend boot logs the following lines, in order:

```
[NestFactory]      Starting Nest application...
[SqliteConnection] Applied migrations: 001_initial.sql, 002_has_existing_test.sql  (first run)
[AiModule]         Selected AI adapter: claude (requires: ANTHROPIC_API_KEY)
[Concurrency]      Sandbox concurrency cap: 4
[Concurrency]      AI concurrency cap: 2
[EventLoopMonitor] Event loop monitor started — warn on stalls ≥ 50ms
[RoutesResolver]   …             (route map for /repositories, /jobs, /config)
[AppModule]        GitHub auth OK — bot user: <your-login>
[AppModule]        Sandbox ready — image present, daemon reachable
[Bootstrap]        Backend listening on :3000
```

The two `AppModule` lines are the live boot validation:
`onModuleInit` calls `GitHubPort.whoami()` and `SandboxPort.assertReady()`
against the real services. A misconfigured PAT or a missing sandbox
image fails boot here with a clear error rather than at first job
time.

## First-time troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required env var: GITHUB_TOKEN` | `.env` not copied or `GITHUB_TOKEN` unset | `cp .env.example .env` and edit |
| `GitHub PAT validation failed: Bad credentials` | Token wrong / expired | Regenerate; verify with the `curl` recipe above |
| `Docker daemon not reachable` | Docker Desktop not running, or `DOCKER_SOCKET_PATH` wrong | Start Docker Desktop; default socket path is `/var/run/docker.sock` |
| `Sandbox image '…' not present on the daemon` | Sandbox image not built | `docker compose up --build` rebuilds; or `docker build -t coverage-improver-sandbox:latest sandbox/` |
| Backend boots but jobs fail immediately with `coverage-improver-sandbox: image platform mismatch` | Apple Silicon: image was built for arm64 but the daemon is trying amd64 (or vice versa) | Add `--platform linux/$(uname -m)` to your `docker compose` invocation, or rebuild on the matching architecture |
| `Insufficient credit` from Anthropic | Account billing not enabled | console.anthropic.com → Billing |
