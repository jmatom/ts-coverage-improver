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

/** `src/foo.ts` → `src/foo.test.ts` (idiomatic; first-time test for this source). */
export function idiomaticSiblingTestPath(sourcePath: string): string {
  const { dir, stem, ext } = splitPath(sourcePath);
  return `${dir}${stem}.test${ext}`;
}

/** `src/foo.ts` → `src/foo.generated.test.ts` (fallback when an existing test file is present). */
export function fallbackSiblingTestPath(sourcePath: string): string {
  const { dir, stem, ext } = splitPath(sourcePath);
  return `${dir}${stem}.generated.test${ext}`;
}

/**
 * Pick the right sibling path based on whether an existing test file was
 * found at orchestrator entry. Caller passes `hasExistingTest`, the rule
 * lives here so the orchestrator and the prompt builder agree on the name.
 */
export function siblingTestPath(sourcePath: string, hasExistingTest = false): string {
  return hasExistingTest
    ? fallbackSiblingTestPath(sourcePath)
    : idiomaticSiblingTestPath(sourcePath);
}
