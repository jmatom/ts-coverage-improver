import { DeleteRepository } from './DeleteRepository';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { RepositoryNotFoundError } from '@domain/errors/DomainError';
import { Repository } from '@domain/repository/Repository';
import { RepositoryId } from '@domain/repository/RepositoryId';

function makeRepo(overrides: Partial<RepositoryRepository> = {}): RepositoryRepository {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findByOwnerAndName: jest.fn(),
    list: jest.fn(),
    findByAnalysisStatus: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRepository(): Repository {
  return Repository.rehydrate({
    id: RepositoryId.new(),
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    forkOwner: null,
    lastAnalyzedAt: null,
    subpath: '',
    analysisStatus: 'idle',
    analysisError: null,
    analysisStartedAt: null,
    analysisAutoRetryCount: 0,
  });
}

describe('DeleteRepository', () => {
  it('throws RepositoryNotFoundError when the repository does not exist', async () => {
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
    const useCase = new DeleteRepository(repo);

    await expect(useCase.execute({ id: RepositoryId.new() })).rejects.toThrow(RepositoryNotFoundError);
  });

  it('deletes the repository when it exists', async () => {
    const repository = makeRepository();
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(repository), delete: deleteFn });
    const useCase = new DeleteRepository(repo);

    await expect(useCase.execute({ id: repository.id })).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalledWith(repository.id);
  });
});
