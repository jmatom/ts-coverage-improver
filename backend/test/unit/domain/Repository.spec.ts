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
