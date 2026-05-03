import { JobStatusValue, JOB_STATUSES } from './JobStatus';
import { DomainInvariantError } from '../errors/DomainError';

describe('JobStatusValue', () => {
  describe('of()', () => {
    it('creates a value object for each valid status', () => {
      for (const status of JOB_STATUSES) {
        expect(JobStatusValue.of(status).value).toBe(status);
      }
    });

    it('throws DomainInvariantError for an unknown status', () => {
      expect(() => JobStatusValue.of('unknown' as any)).toThrow(DomainInvariantError);
    });
  });

  describe('pending()', () => {
    it('creates a pending status', () => {
      expect(JobStatusValue.pending().value).toBe('pending');
    });
  });

  describe('isTerminal()', () => {
    it('returns false for pending', () => {
      expect(JobStatusValue.of('pending').isTerminal()).toBe(false);
    });

    it('returns false for running', () => {
      expect(JobStatusValue.of('running').isTerminal()).toBe(false);
    });

    it('returns true for succeeded', () => {
      expect(JobStatusValue.of('succeeded').isTerminal()).toBe(true);
    });

    it('returns true for failed', () => {
      expect(JobStatusValue.of('failed').isTerminal()).toBe(true);
    });
  });

  describe('equals()', () => {
    it('returns true when both values are the same', () => {
      expect(JobStatusValue.of('pending').equals(JobStatusValue.of('pending'))).toBe(true);
    });

    it('returns false when values differ', () => {
      expect(JobStatusValue.of('pending').equals(JobStatusValue.of('running'))).toBe(false);
    });
  });

  describe('transitionTo()', () => {
    it('allows pending → running', () => {
      expect(JobStatusValue.of('pending').transitionTo('running').value).toBe('running');
    });

    it('allows pending → failed', () => {
      expect(JobStatusValue.of('pending').transitionTo('failed').value).toBe('failed');
    });

    it('allows running → succeeded', () => {
      expect(JobStatusValue.of('running').transitionTo('succeeded').value).toBe('succeeded');
    });

    it('allows running → failed', () => {
      expect(JobStatusValue.of('running').transitionTo('failed').value).toBe('failed');
    });

    it('throws DomainInvariantError for pending → succeeded', () => {
      expect(() => JobStatusValue.of('pending').transitionTo('succeeded')).toThrow(DomainInvariantError);
    });

    it('throws DomainInvariantError for running → pending', () => {
      expect(() => JobStatusValue.of('running').transitionTo('pending')).toThrow(DomainInvariantError);
    });

    it('throws DomainInvariantError for succeeded → any', () => {
      expect(() => JobStatusValue.of('succeeded').transitionTo('running')).toThrow(DomainInvariantError);
    });

    it('throws DomainInvariantError for failed → any', () => {
      expect(() => JobStatusValue.of('failed').transitionTo('running')).toThrow(DomainInvariantError);
    });
  });
});
