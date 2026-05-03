import { RepositoryId } from '../../../src/domain/repository/RepositoryId';
import { DomainInvariantError } from '../../../src/domain/errors/DomainError';

describe('RepositoryId', () => {
  describe('new', () => {
    it('mints a fresh UUID-shaped ID', () => {
      const a = RepositoryId.new();
      const b = RepositoryId.new();
      expect(a.value).not.toBe(b.value);
      expect(a.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('of', () => {
    it('accepts a well-formed UUID', () => {
      const raw = '550e8400-e29b-41d4-a716-446655440000';
      expect(RepositoryId.of(raw).value).toBe(raw);
    });

    it('accepts an uppercase UUID (case-insensitive)', () => {
      const raw = '550E8400-E29B-41D4-A716-446655440000';
      expect(() => RepositoryId.of(raw)).not.toThrow();
    });

    it('rejects a non-UUID string', () => {
      expect(() => RepositoryId.of('repo-1')).toThrow(DomainInvariantError);
    });

    it('rejects empty string', () => {
      expect(() => RepositoryId.of('')).toThrow(DomainInvariantError);
    });

    it('rejects non-string input', () => {
      expect(() => RepositoryId.of(undefined as unknown as string)).toThrow(DomainInvariantError);
      expect(() => RepositoryId.of(123 as unknown as string)).toThrow(DomainInvariantError);
    });
  });

  it('equals is structural', () => {
    const raw = '550e8400-e29b-41d4-a716-446655440000';
    expect(RepositoryId.of(raw).equals(RepositoryId.of(raw))).toBe(true);
    expect(RepositoryId.of(raw).equals(RepositoryId.new())).toBe(false);
  });

  it('toString returns the raw value', () => {
    const raw = '550e8400-e29b-41d4-a716-446655440000';
    expect(`${RepositoryId.of(raw)}`).toBe(raw);
  });
});
