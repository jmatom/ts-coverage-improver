import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LcovParser } from '../../../src/domain/coverage/LcovParser';

describe('LcovParser', () => {
  it('parses a simple multi-file lcov.info', () => {
    const raw = readFileSync(join(__dirname, '../../fixtures/lcov/simple.info'), 'utf8');
    const files = LcovParser.parse(raw);

    expect(files).toHaveLength(3);

    const sum = files.find((f) => f.path === 'src/sum.ts')!;
    expect(sum.linesPct).toBe(100);
    expect(sum.functionsPct).toBe(100);
    expect(sum.branchesPct).toBeNull();
    expect(sum.uncoveredLines).toEqual([]);

    const divide = files.find((f) => f.path === 'src/divide.ts')!;
    expect(divide.linesPct).toBe(60);
    expect(divide.branchesPct).toBe(50);
    expect(divide.functionsPct).toBe(100);
    expect(divide.uncoveredLines).toEqual([3, 4]);

    const empty = files.find((f) => f.path === 'src/empty.ts')!;
    expect(empty.linesPct).toBe(100); // 0/0 → defined as 100% (no instrumentation = nothing to cover)
  });

  it('tolerates CRLF line endings and trailing whitespace', () => {
    const raw = ['SF:a.ts', 'DA:1,1', 'DA:2,0', 'LF:2', 'LH:1', 'end_of_record', ''].join('\r\n');
    const files = LcovParser.parse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].linesPct).toBe(50);
    expect(files[0].uncoveredLines).toEqual([2]);
  });

  it('handles a record without explicit end_of_record', () => {
    const raw = ['SF:b.ts', 'DA:1,1', 'LF:1', 'LH:1'].join('\n');
    const files = LcovParser.parse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('b.ts');
  });

  it('returns empty array for empty input', () => {
    expect(LcovParser.parse('')).toEqual([]);
    expect(LcovParser.parse('   \n\n')).toEqual([]);
  });

  it('ignores junk before the first SF: line', () => {
    const raw = ['# comment', 'TN:', 'SF:c.ts', 'DA:1,1', 'LF:1', 'LH:1', 'end_of_record'].join(
      '\n',
    );
    expect(LcovParser.parse(raw)).toHaveLength(1);
  });
});
