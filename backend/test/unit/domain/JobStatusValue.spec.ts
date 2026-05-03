import { JobStatusValue } from '../../../src/domain/job/JobStatus';
import { DomainInvariantError } from '../../../src/domain/errors/DomainError';

describe('JobStatusValue', () => {
  it('constructs only valid statuses', () => {
    expect(JobStatusValue.of('pending').value).toBe('pending');
    expect(JobStatusValue.of('running').value).toBe('running');
    expect(JobStatusValue.of('succeeded').value).toBe('succeeded');
    expect(JobStatusValue.of('failed').value).toBe('failed');
    expect(() => JobStatusValue.of('weird' as never)).toThrow(DomainInvariantError);
  });

  it('pending() returns a fresh pending VO', () => {
    expect(JobStatusValue.pending().value).toBe('pending');
  });

  it('isTerminal classifies succeeded/failed as terminal, others not', () => {
    expect(JobStatusValue.of('succeeded').isTerminal()).toBe(true);
    expect(JobStatusValue.of('failed').isTerminal()).toBe(true);
    expect(JobStatusValue.of('pending').isTerminal()).toBe(false);
    expect(JobStatusValue.of('running').isTerminal()).toBe(false);
  });

  describe('transitionTo', () => {
    it('pending → running is allowed', () => {
      expect(JobStatusValue.of('pending').transitionTo('running').value).toBe('running');
    });

    it('pending → failed is allowed (boot-time reconcile path)', () => {
      expect(JobStatusValue.of('pending').transitionTo('failed').value).toBe('failed');
    });

    it('running → succeeded is allowed', () => {
      expect(JobStatusValue.of('running').transitionTo('succeeded').value).toBe('succeeded');
    });

    it('running → failed is allowed', () => {
      expect(JobStatusValue.of('running').transitionTo('failed').value).toBe('failed');
    });

    it('rejects illegal transitions: pending → succeeded', () => {
      expect(() => JobStatusValue.of('pending').transitionTo('succeeded')).toThrow(
        /Illegal job status transition.*pending.*succeeded/,
      );
    });

    it('rejects illegal transitions: succeeded → anything', () => {
      const succ = JobStatusValue.of('succeeded');
      expect(() => succ.transitionTo('failed')).toThrow(DomainInvariantError);
      expect(() => succ.transitionTo('running')).toThrow(DomainInvariantError);
      expect(() => succ.transitionTo('pending')).toThrow(DomainInvariantError);
    });

    it('rejects illegal transitions: failed → anything', () => {
      const failed = JobStatusValue.of('failed');
      expect(() => failed.transitionTo('succeeded')).toThrow(DomainInvariantError);
      expect(() => failed.transitionTo('running')).toThrow(DomainInvariantError);
      expect(() => failed.transitionTo('pending')).toThrow(DomainInvariantError);
    });

    it('rejects self-transitions (no-op transitions are not legal)', () => {
      expect(() => JobStatusValue.of('running').transitionTo('running')).toThrow(
        DomainInvariantError,
      );
    });

    it('returns a new VO instance — does not mutate the source', () => {
      const original = JobStatusValue.of('pending');
      const next = original.transitionTo('running');
      expect(original.value).toBe('pending'); // unchanged
      expect(next.value).toBe('running');
    });
  });

  it('equals is structural', () => {
    expect(JobStatusValue.of('pending').equals(JobStatusValue.of('pending'))).toBe(true);
    expect(JobStatusValue.of('pending').equals(JobStatusValue.of('running'))).toBe(false);
  });
});
