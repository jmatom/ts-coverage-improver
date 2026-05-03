-- 006 — drop file_coverages.statements_pct
--
-- The column was always written as NULL: lcov doesn't carry a separate
-- "statements" metric (Istanbul's lcov reporter emits per-line `DA` records
-- that we already store as `lines_pct` + `uncovered_lines`). Nothing reads
-- the column — not the controllers, not the frontend, not the use cases.
--
-- SQLite ≥3.35 supports ALTER TABLE ... DROP COLUMN; the bundled node:sqlite
-- in Node 20 ships well above that, so this is a single statement.
ALTER TABLE file_coverages DROP COLUMN statements_pct;
