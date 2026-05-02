-- Per-source-file flag: did we observe a sibling test file at analysis time?
-- Used by the dashboard to differentiate "needs an *append*-mode improvement"
-- from "needs a brand-new sibling test file". Computed by AnalyzeRepositoryCoverage
-- after the clone, by probing common test-file conventions on the filesystem.
--
-- Nullable: NULL means "older row, before this column was introduced." Future
-- rows always populate the value (true or false).
ALTER TABLE file_coverages ADD COLUMN has_existing_test INTEGER;
