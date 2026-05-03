import { TestConvention } from '../job/testFileNaming';

/**
 * Port: walk a package root and decide which sibling-test naming
 * convention the project uses (`<base>.test.<ext>` vs `<base>.spec.<ext>`).
 * Whichever suffix is more common among existing test files wins; default
 * to `'test'` on tie or empty (Jest's recommendation).
 *
 * Used by `RunImprovementJob` once per attempt so the AI's generated
 * sibling file matches the project's existing style instead of forcing
 * `.test`.
 */
export interface TestConventionDetectorPort {
  detect(packageRoot: string): Promise<TestConvention>;
}
