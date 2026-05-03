/**
 * Port: probe a checked-out workdir for an existing sibling test file
 * matching common conventions (`<basename>.test.ts`, `.spec.ts`,
 * `__tests__/<basename>.test.ts`, etc.). Returns the relative path of
 * the first match, or null if none.
 *
 * Used by `AnalyzeRepositoryCoverage` to populate `FileCoverage.hasExistingTest`
 * (so the dashboard can distinguish "needs append" from "needs sibling")
 * and by `RunImprovementJob` to choose append-vs-sibling mode at job time.
 */
export interface SiblingTestPathFinderPort {
  findExisting(workdir: string, sourcePath: string): Promise<string | null>;
}
