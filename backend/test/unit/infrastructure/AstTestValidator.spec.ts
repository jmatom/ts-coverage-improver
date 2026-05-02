import { AstTestValidator } from '../../../src/infrastructure/validation/AstTestValidator';

const before = `
describe('Sum', () => {
  it('adds positive numbers', () => {
    expect(1 + 1).toBe(2);
  });
});
`.trim();

const validator = new AstTestValidator();

describe('AstTestValidator', () => {
  describe('validateAppend', () => {
    it('accepts a valid append (existing block kept, new block added)', () => {
      const after = `
describe('Sum', () => {
  it('adds positive numbers', () => {
    expect(1 + 1).toBe(2);
  });
  it('adds negative numbers', () => {
    expect(-1 + -1).toBe(-2);
  });
});
`.trim();
      const result = validator.validateAppend('foo.test.ts', before, after);
      expect(result.ok).toBe(true);
    });

    it('rejects when a pre-existing test was removed', () => {
      const after = `
describe('Sum', () => {
  it('adds negative numbers', () => {
    expect(-1 + -1).toBe(-2);
  });
});
`.trim();
      const result = validator.validateAppend('foo.test.ts', before, after);
      expect(result.ok).toBe(false);
      expect(result.violations.find((v) => v.kind === 'missing_block')).toBeTruthy();
    });

    it('rejects when no new tests were added', () => {
      const result = validator.validateAppend('foo.test.ts', before, before);
      expect(result.ok).toBe(false);
      expect(result.violations.find((v) => v.kind === 'no_new_blocks')).toBeTruthy();
    });

    it('rejects when a pre-existing description was renamed', () => {
      const after = `
describe('Sum', () => {
  it('adds positive numbers (renamed)', () => {
    expect(1 + 1).toBe(2);
  });
  it('adds negative numbers', () => {
    expect(-1 + -1).toBe(-2);
  });
});
`.trim();
      const result = validator.validateAppend('foo.test.ts', before, after);
      expect(result.ok).toBe(false);
      expect(result.violations[0].message).toMatch(/adds positive numbers/);
    });

    it('handles describe.skip and it.only modifiers as same logical fn', () => {
      const beforeMod = `
describe.skip('Suite', () => {
  it.only('runs only this', () => {});
});
`.trim();
      const afterMod = `
describe.skip('Suite', () => {
  it.only('runs only this', () => {});
  it('runs another', () => {});
});
`.trim();
      const result = validator.validateAppend('foo.test.ts', beforeMod, afterMod);
      expect(result.ok).toBe(true);
    });

    it('flags parse errors as a violation, not a throw', () => {
      const broken = `describe('x', () => { it('y',`;
      const result = validator.validateAppend('foo.test.ts', before, broken);
      expect(result.ok).toBe(false);
      expect(result.violations[0].kind).toBe('parse_error');
    });
  });

  describe('validateNew', () => {
    it('accepts a fresh sibling test file with at least one it/test block', () => {
      const newFile = `
import { sum } from './sum';
describe('sum', () => {
  it('works', () => {
    expect(sum(1, 2)).toBe(3);
  });
});
`.trim();
      const result = validator.validateNew('sum.generated.test.ts', newFile);
      expect(result.ok).toBe(true);
    });

    it('rejects an empty file', () => {
      const result = validator.validateNew('empty.test.ts', '');
      expect(result.ok).toBe(false);
    });

    it('rejects a file with describes but no it/test', () => {
      const result = validator.validateNew(
        'shell.test.ts',
        `describe('outer', () => { describe('inner', () => {}); });`,
      );
      expect(result.ok).toBe(false);
      expect(result.violations[0].kind).toBe('no_new_blocks');
    });
  });
});
