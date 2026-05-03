import { Subpath } from '../../../src/domain/repository/Subpath';
import { DomainInvariantError } from '../../../src/domain/errors/DomainError';

describe('Subpath', () => {
  it('empty input → empty Subpath (= repo root)', () => {
    expect(Subpath.of('').value).toBe('');
    expect(Subpath.of('').isEmpty()).toBe(true);
  });

  it('Subpath.empty() factory matches', () => {
    expect(Subpath.empty().value).toBe('');
  });

  it('strips leading/trailing slashes', () => {
    expect(Subpath.of('/backend').value).toBe('backend');
    expect(Subpath.of('backend/').value).toBe('backend');
    expect(Subpath.of('/backend/').value).toBe('backend');
    expect(Subpath.of('//apps/web//').value).toBe('apps/web');
  });

  it('trims whitespace', () => {
    expect(Subpath.of('  backend  ').value).toBe('backend');
    expect(Subpath.of('   ').value).toBe(''); // pure whitespace → empty
  });

  it('preserves nested paths', () => {
    expect(Subpath.of('apps/web').value).toBe('apps/web');
    expect(Subpath.of('packages/core/src').value).toBe('packages/core/src');
  });

  describe('rejects path traversal', () => {
    it('plain ".."', () => {
      expect(() => Subpath.of('..')).toThrow(DomainInvariantError);
    });

    it('".." segment in middle', () => {
      expect(() => Subpath.of('apps/../etc')).toThrow(DomainInvariantError);
    });

    it('".." prefix', () => {
      expect(() => Subpath.of('../escape')).toThrow(DomainInvariantError);
    });

    it('".." suffix', () => {
      expect(() => Subpath.of('apps/..')).toThrow(DomainInvariantError);
    });

    it('empty segments (// inside path → invalid after trim)', () => {
      expect(() => Subpath.of('apps//web')).toThrow(DomainInvariantError);
    });
  });

  it('isEmpty distinguishes root from nested', () => {
    expect(Subpath.of('').isEmpty()).toBe(true);
    expect(Subpath.of('backend').isEmpty()).toBe(false);
  });

  it('equals is structural', () => {
    expect(Subpath.of('backend').equals(Subpath.of('backend'))).toBe(true);
    expect(Subpath.of('/backend/').equals(Subpath.of('backend'))).toBe(true); // normalize
    expect(Subpath.of('backend').equals(Subpath.of('frontend'))).toBe(false);
    expect(Subpath.empty().equals(Subpath.of(''))).toBe(true);
  });
});
