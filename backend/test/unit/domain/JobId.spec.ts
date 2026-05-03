import { JobId } from '../../../src/domain/job/JobId';
import { DomainInvariantError } from '../../../src/domain/errors/DomainError';

describe('JobId', () => {
  describe('new', () => {
    it('mints a fresh UUID-shaped ID', () => {
      const a = JobId.new();
      const b = JobId.new();
      expect(a.value).not.toBe(b.value);
      expect(a.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('of', () => {
    it('accepts a well-formed UUID', () => {
      const raw = '550e8400-e29b-41d4-a716-446655440000';
      expect(JobId.of(raw).value).toBe(raw);
    });

    it('rejects a non-UUID string', () => {
      expect(() => JobId.of('job-42')).toThrow(DomainInvariantError);
    });

    it('rejects non-string input', () => {
      expect(() => JobId.of(null as unknown as string)).toThrow(DomainInvariantError);
    });
  });

  it('equals is structural', () => {
    const raw = '550e8400-e29b-41d4-a716-446655440000';
    expect(JobId.of(raw).equals(JobId.of(raw))).toBe(true);
    expect(JobId.of(raw).equals(JobId.new())).toBe(false);
  });
});
