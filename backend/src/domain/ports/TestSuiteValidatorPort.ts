export interface ValidationViolation {
  kind: 'parse_error' | 'missing_block' | 'no_new_blocks';
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: ValidationViolation[];
}

/**
 * Port for the AST safety net used in append-mode AI edits.
 *
 *  - `parseCheck(filename, content)` — cheap syntactic check; used by the
 *    orchestrator BEFORE spawning a sandbox, to fast-fail on a corrupt
 *    existing test file. The repo is broken; we don't run the AI.
 *  - `validateAppend(filename, before, after)` — every pre-existing test
 *    block in `before` must still be present (unchanged description) in
 *    `after`, and at least one new block must have been added.
 *  - `validateNew(filename, content)` — the freshly-written file must
 *    parse and contain at least one `it`/`test` block.
 *
 * Implementation lives in infrastructure (TypeScript compiler API), but
 * the rule itself is a domain rule about what a "safe AI edit" means.
 */
export interface TestSuiteValidatorPort {
  parseCheck(filename: string, content: string): ValidationResult;
  validateAppend(filename: string, before: string, after: string): ValidationResult;
  validateNew(filename: string, content: string): ValidationResult;
}
