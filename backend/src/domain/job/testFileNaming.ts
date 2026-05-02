/**
 * Domain rules for naming a "sibling" test file produced by the AI.
 *
 * Two distinct cases:
 *
 *   - **Pure sibling**: there's no existing test file at all. The AI is
 *     creating the first test for this source. Use the idiomatic name
 *     `<basename>.test.ts` — it's the canonical convention and the human
 *     reviewer expects to find tests there.
 *
 *   - **Fallback sibling**: an existing `<basename>.test.ts` was present
 *     but the AI couldn't safely append (structural failure: parse_error
 *     or missing_block in append mode). We can't overwrite the existing
 *     file, so we land the new tests in `<basename>.generated.test.ts`
 *     beside it. The `.generated` suffix is a deliberate signal to the
 *     reviewer: "the AI wrote this as a separate file because it couldn't
 *     merge with the existing test."
 */

function splitPath(sourcePath: string): { dir: string; stem: string; ext: string } {
  const dir = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1)
    : '';
  const file = sourcePath.includes('/')
    ? sourcePath.slice(sourcePath.lastIndexOf('/') + 1)
    : sourcePath;
  const stem = file.replace(/\.(ts|tsx|js|jsx|mts|cts)$/i, '');
  const ext = file.slice(stem.length) || '.ts';
  return { dir, stem, ext };
}

/** Which infix the project uses on test filenames: `<base>.test.ts` vs `<base>.spec.ts`. */
export type TestConvention = 'test' | 'spec';

/** `src/foo.ts` → `src/foo.test.ts` (or `.spec.ts` per project convention). */
export function idiomaticSiblingTestPath(
  sourcePath: string,
  convention: TestConvention = 'test',
): string {
  const { dir, stem, ext } = splitPath(sourcePath);
  return `${dir}${stem}.${convention}${ext}`;
}

/** `src/foo.ts` → `src/foo.generated.test.ts` (fallback when an existing test file is present). */
export function fallbackSiblingTestPath(
  sourcePath: string,
  convention: TestConvention = 'test',
): string {
  const { dir, stem, ext } = splitPath(sourcePath);
  return `${dir}${stem}.generated.${convention}${ext}`;
}

/**
 * Pick the right sibling path based on whether an existing test file was
 * found at orchestrator entry, and which infix convention the project uses.
 * Caller passes `hasExistingTest` and `convention`; the rule lives here so
 * the orchestrator and the prompt builder agree on the name.
 */
export function siblingTestPath(
  sourcePath: string,
  hasExistingTest = false,
  convention: TestConvention = 'test',
): string {
  return hasExistingTest
    ? fallbackSiblingTestPath(sourcePath, convention)
    : idiomaticSiblingTestPath(sourcePath, convention);
}
