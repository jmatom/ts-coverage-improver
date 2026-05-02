-- Optional subpath for monorepos: the directory inside the cloned repo
-- where this package's `package.json` lives. Empty string = repo root
-- (the common case). Examples: '', 'backend', 'apps/web', 'packages/core'.
--
-- All package-level operations (install, tests, AI invocation, file probes)
-- run with workdir = repo_clone_root + '/' + subpath. Git operations
-- (clone, push, PR) stay at the repo clone root regardless.
ALTER TABLE repositories ADD COLUMN subpath TEXT NOT NULL DEFAULT '';
