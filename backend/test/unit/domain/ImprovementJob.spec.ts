import { ImprovementJob } from '../../../src/domain/job/ImprovementJob';

describe('ImprovementJob', () => {
  const create = () =>
    ImprovementJob.create({ repositoryId: 'r1', targetFilePath: 'src/foo.ts' });

  it('starts in pending status', () => {
    const job = create();
    expect(job.status).toBe('pending');
    expect(job.isTerminal()).toBe(false);
  });

  it('transitions pending → running via start()', () => {
    const job = create();
    job.start(42);
    expect(job.status).toBe('running');
    expect(job.coverageBefore).toBe(42);
    expect(job.startedAt).toBeInstanceOf(Date);
  });

  it('rejects start() from non-pending', () => {
    const job = create();
    job.start(42);
    expect(() => job.start(50)).toThrow(/Illegal job status transition/);
  });

  it('succeeds with prUrl + coverageAfter + mode', () => {
    const job = create();
    job.start(40);
    job.succeed({ prUrl: 'https://gh/pr/1', coverageAfter: 90, mode: 'append' });
    expect(job.status).toBe('succeeded');
    expect(job.prUrl).toBe('https://gh/pr/1');
    expect(job.coverageAfter).toBe(90);
    expect(job.mode).toBe('append');
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.isTerminal()).toBe(true);
  });

  it('rejects succeed() from non-running', () => {
    const job = create();
    expect(() =>
      job.succeed({ prUrl: 'x', coverageAfter: 100, mode: 'sibling' }),
    ).toThrow(/Illegal job status transition/);
  });

  it('rejects empty prUrl on succeed', () => {
    const job = create();
    job.start(0);
    expect(() => job.succeed({ prUrl: '', coverageAfter: 100, mode: 'append' })).toThrow();
  });

  it('fails from pending or running, not from terminal', () => {
    const j1 = create();
    j1.fail('explode');
    expect(j1.status).toBe('failed');

    const j2 = create();
    j2.start(0);
    j2.fail('explode');
    expect(j2.status).toBe('failed');

    const j3 = create();
    j3.start(0);
    j3.succeed({ prUrl: 'x', coverageAfter: 100, mode: 'append' });
    expect(() => j3.fail('after')).toThrow(/Illegal job status transition/);
  });

  it('rejects empty repositoryId or targetFilePath', () => {
    expect(() => ImprovementJob.create({ repositoryId: '', targetFilePath: 'x' })).toThrow();
    expect(() =>
      ImprovementJob.create({ repositoryId: 'r', targetFilePath: '   ' }),
    ).toThrow();
  });

  it('setMode is only allowed while running', () => {
    const j = create();
    expect(() => j.setMode('append')).toThrow();
    j.start(0);
    j.setMode('sibling');
    expect(j.mode).toBe('sibling');
  });
});
