# Per-job sandbox image.
#
# Used by the backend's DockerSandbox adapter to run untrusted code from
# third-party repositories: `npm install`, `npm test --coverage`, and the
# AI CLI (Claude Code by default). Built once at compose-up; reused for
# every job.
#
# Isolation: a container from this image is created per job, with the
# job's workdir bind-mounted at /workspace and a hard runtime timeout.
# Networking uses Docker's default bridge — strong filesystem isolation,
# NAT'd network. Production hardening (custom network with egress
# allow-list to GitHub + Anthropic API + npm registry) is documented as
# roadmap; bridge is sufficient for the 3-day demo.

FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — drives the AICliPort default adapter. Other adapters
# (e.g. Gemini) would add their own CLI install line here when wired.
RUN npm install -g @anthropic-ai/claude-code@latest \
 && claude --version

# Enable corepack so we can support pnpm/yarn projects without per-job installs.
RUN corepack enable

# fnm — fast Node manager (Rust). Lets us switch the Node major per job
# based on the project's `.nvmrc` or `engines.node` pin (see
# NodeVersionDetector). Pre-install the supported set so per-job switching
# is instant; Node 20 (already in the base image) stays the default
# fallback when no pin is detected, preserving zero-overhead runs for
# projects that don't pin a version.
ENV FNM_DIR=/usr/local/share/fnm
ENV PATH=/usr/local/share/fnm:$PATH
RUN curl -fsSL https://fnm.vercel.app/install \
      | bash -s -- --skip-shell --install-dir /usr/local/share/fnm \
 && /usr/local/share/fnm/fnm install 18 \
 && /usr/local/share/fnm/fnm install 22 \
 && /usr/local/share/fnm/fnm install 24 \
 && chmod -R a+rX /usr/local/share/fnm

# Drop privileges before the container runs.
#
# The official `node:20-slim` image ships a non-root `node` user (uid 1000).
# We switch to it for two reasons:
#   1. Defense-in-depth: even though the container is isolated, the AI
#      runs untrusted code (the cloned repo's postinstall scripts) — running
#      as non-root reduces blast radius if anything escapes the sandbox.
#   2. Claude Code's `--dangerously-skip-permissions` flag refuses to run
#      under root/sudo for the same reason. Headless mode is unusable as
#      root; it only works under an unprivileged user.
#
# /workspace is created up front and chowned so bind-mounts resolve cleanly.
RUN mkdir -p /workspace && chown -R node:node /workspace
USER node
WORKDIR /workspace

# Trust any directory git encounters inside this container.
#
# The backend clones the workdir as root (the host-side clone runs as the
# backend container's user). When the sandbox — running as `node` — invokes
# git on that workdir, git's dubious-ownership safeguard refuses with:
#   "fatal: detected dubious ownership in repository at ..."
# That guard is meant to protect interactive shells from operating on
# attacker-planted repos. Inside this sandbox the container itself is the
# trust boundary, so we tell git to trust any path. Equivalent to:
#   git config --global --add safe.directory '*'
RUN git config --global --add safe.directory '*'

# No CMD/ENTRYPOINT — the backend supplies the command per job.
