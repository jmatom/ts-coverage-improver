import { Repository } from '../../../src/domain/repository/Repository';

describe('Repository', () => {
  it('creates a repo with non-empty owner+name', () => {
    const repo = Repository.create({ owner: 'octocat', name: 'hello-world', defaultBranch: 'main' });
    expect(repo.fullName).toBe('octocat/hello-world');
    expect(repo.cloneUrl).toBe('https://github.com/octocat/hello-world.git');
    expect(repo.lastAnalyzedAt).toBeNull();
    expect(repo.forkOwner).toBeNull();
  });

  it('rejects empty owner or name', () => {
    expect(() => Repository.create({ owner: '', name: 'x', defaultBranch: 'main' })).toThrow();
    expect(() => Repository.create({ owner: 'x', name: '   ', defaultBranch: 'main' })).toThrow();
  });

  it('records fork owner once set', () => {
    const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
    repo.recordFork('forker');
    expect(repo.forkOwner).toBe('forker');
  });

  it('marks analyzed', () => {
    const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
    const at = new Date('2026-05-01T12:00:00Z');
    repo.markAnalyzed(at);
    expect(repo.lastAnalyzedAt).toEqual(at);
  });

  describe('analysis lifecycle', () => {
    it('starts in idle with no error or startedAt', () => {
      const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
      expect(repo.analysisStatus).toBe('idle');
      expect(repo.analysisError).toBeNull();
      expect(repo.analysisStartedAt).toBeNull();
      expect(repo.isAnalyzing).toBe(false);
    });

    it('idle → pending → running → idle on success path', () => {
      const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      expect(repo.analysisStatus).toBe('pending');
      expect(repo.isAnalyzing).toBe(true);

      const startedAt = new Date('2026-05-01T13:00:00Z');
      repo.markAnalysisRunning(startedAt);
      expect(repo.analysisStatus).toBe('running');
      expect(repo.analysisStartedAt).toEqual(startedAt);
      expect(repo.isAnalyzing).toBe(true);

      const completedAt = new Date('2026-05-01T13:02:00Z');
      repo.markAnalyzed(completedAt);
      expect(repo.analysisStatus).toBe('idle');
      expect(repo.lastAnalyzedAt).toEqual(completedAt);
      expect(repo.analysisError).toBeNull();
      expect(repo.analysisStartedAt).toBeNull();
      expect(repo.isAnalyzing).toBe(false);
    });

    it('running → failed records the error', () => {
      const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      repo.markAnalysisRunning();
      repo.markAnalysisFailed('npm install timed out');
      expect(repo.analysisStatus).toBe('failed');
      expect(repo.analysisError).toBe('npm install timed out');
      // lastAnalyzedAt remains untouched on failure (it reflects the last
      // SUCCESSFUL analysis, not the last attempt).
      expect(repo.lastAnalyzedAt).toBeNull();
    });

    it('a new request from failed clears the error and goes to pending', () => {
      const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      repo.markAnalysisRunning();
      repo.markAnalysisFailed('boom');
      expect(repo.analysisStatus).toBe('failed');

      repo.markAnalysisRequested();
      expect(repo.analysisStatus).toBe('pending');
      expect(repo.analysisError).toBeNull();
    });

    it('refuses to overlap a new request while one is running', () => {
      const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
      repo.markAnalysisRequested();
      repo.markAnalysisRunning();
      expect(() => repo.markAnalysisRequested()).toThrow(
        /Cannot request a new analysis while one is currently running/i,
      );
    });

    it('refuses to start running from anything other than pending', () => {
      const repo = Repository.create({ owner: 'a', name: 'b', defaultBranch: 'main' });
      // idle → running invalid
      expect(() => repo.markAnalysisRunning()).toThrow();
      // failed → running invalid (must go through pending again)
      repo.markAnalysisRequested();
      repo.markAnalysisRunning();
      repo.markAnalysisFailed('x');
      expect(() => repo.markAnalysisRunning()).toThrow();
    });
  });

  describe('parseUrl', () => {
    it.each([
      ['https://github.com/octocat/hello-world', 'octocat', 'hello-world'],
      ['https://github.com/octocat/hello-world.git', 'octocat', 'hello-world'],
      ['https://github.com/octocat/hello-world/', 'octocat', 'hello-world'],
      ['git@github.com:octocat/hello-world.git', 'octocat', 'hello-world'],
    ])('parses %s', (url, owner, name) => {
      expect(Repository.parseUrl(url)).toEqual({ owner, name });
    });

    it('rejects unsupported URLs', () => {
      expect(() => Repository.parseUrl('https://gitlab.com/x/y')).toThrow();
      expect(() => Repository.parseUrl('not-a-url')).toThrow();
    });
  });
});
