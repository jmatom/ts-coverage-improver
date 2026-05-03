import * as ts from 'typescript';
import {
  TestSuiteValidatorPort,
  ValidationResult,
  ValidationViolation,
} from '@domain/ports/TestSuiteValidatorPort';

const TEST_FUNCTION_NAMES = new Set([
  'describe',
  'it',
  'test',
  'xdescribe',
  'xit',
  'xtest',
  'fdescribe',
  'fit',
]);

const TEST_FUNCTION_MODIFIERS = new Set(['skip', 'only', 'each', 'concurrent', 'failing']);

interface TestBlock {
  fn: string;
  description: string | null;
  line: number;
}

/**
 * `TestSuiteValidatorPort` implementation using the TypeScript compiler API.
 *
 * Append-mode invariants enforced (in this order):
 *   1. The post-AI file still parses (no syntax error).
 *   2. Every pre-existing block (matched by `(fn, description)` for static
 *      descriptions) is still present.
 *   3. At least one new block was added.
 *
 * Sibling-mode is a subset: file parses + has at least one `it`/`test`.
 */
export class AstTestSuiteValidator implements TestSuiteValidatorPort {
  /**
   * Cheap syntactic check used by the orchestrator BEFORE the AI runs.
   * If `false`, the existing test file is malformed — the repo is broken
   * and no amount of AI work will help. The job fails fast without
   * spending a sandbox spawn.
   */
  parseCheck(filename: string, content: string): ValidationResult {
    const r = AstTestSuiteValidator.tryParse(filename, content);
    if (!r.ok) {
      return { ok: false, violations: [{ kind: 'parse_error', message: r.error }] };
    }
    return { ok: true, violations: [] };
  }

  validateNew(filename: string, content: string): ValidationResult {
    const parse = AstTestSuiteValidator.tryParse(filename, content);
    if (!parse.ok) {
      return { ok: false, violations: [{ kind: 'parse_error', message: parse.error }] };
    }
    const blocks = collectBlocks(parse.sf);
    if (!blocks.some((b) => b.fn === 'it' || b.fn === 'test')) {
      return {
        ok: false,
        violations: [
          {
            kind: 'no_new_blocks',
            message: 'Generated test file has no `it` or `test` blocks',
          },
        ],
      };
    }
    return { ok: true, violations: [] };
  }

  validateAppend(filename: string, before: string, after: string): ValidationResult {
    const parsed = AstTestSuiteValidator.tryParse(filename, after);
    if (!parsed.ok) {
      return { ok: false, violations: [{ kind: 'parse_error', message: parsed.error }] };
    }
    const beforeBlocks = collectBlocks(
      ts.createSourceFile(filename, before, ts.ScriptTarget.ES2022, true),
    );
    const afterBlocks = collectBlocks(parsed.sf);
    const violations: ValidationViolation[] = [];

    for (const b of beforeBlocks) {
      if (b.description === null) continue;
      const stillThere = afterBlocks.some(
        (a) => a.fn === b.fn && a.description === b.description,
      );
      if (!stillThere) {
        violations.push({
          kind: 'missing_block',
          message: `pre-existing test \`${b.fn}('${b.description}')\` was removed or renamed`,
        });
      }
    }
    if (afterBlocks.length <= beforeBlocks.length) {
      violations.push({
        kind: 'no_new_blocks',
        message: `expected new test blocks; before=${beforeBlocks.length}, after=${afterBlocks.length}`,
      });
    }
    return { ok: violations.length === 0, violations };
  }

  private static tryParse(
    filename: string,
    content: string,
  ): { ok: true; sf: ts.SourceFile } | { ok: false; error: string } {
    try {
      const sf = ts.createSourceFile(filename, content, ts.ScriptTarget.ES2022, true);
      const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
      if (diags && diags.length > 0) {
        const first = diags[0];
        const msg = ts.flattenDiagnosticMessageText(first.messageText, '\n');
        return { ok: false, error: `parse error: ${msg}` };
      }
      return { ok: true, sf };
    } catch (e) {
      return { ok: false, error: `parse exception: ${(e as Error).message}` };
    }
  }
}

function collectBlocks(sf: ts.SourceFile): TestBlock[] {
  const out: TestBlock[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = unwrapCallName(node.expression);
      if (fn && TEST_FUNCTION_NAMES.has(fn)) {
        const desc = node.arguments[0];
        const description = staticString(desc);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ fn, description, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function unwrapCallName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const headName = ts.isIdentifier(expr.expression)
      ? expr.expression.text
      : unwrapCallName(expr.expression);
    if (
      headName &&
      TEST_FUNCTION_NAMES.has(headName) &&
      TEST_FUNCTION_MODIFIERS.has(expr.name.text)
    ) {
      return headName;
    }
  }
  if (ts.isCallExpression(expr)) {
    return unwrapCallName(expr.expression);
  }
  return null;
}

function staticString(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}
