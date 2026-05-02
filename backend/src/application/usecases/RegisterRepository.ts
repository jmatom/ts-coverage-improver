import { Repository } from '@domain/repository/Repository';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { GitHubPort } from '@domain/ports/GitHubPort';
import {
  ForkingDisabledError,
  UpstreamRepoUnreachableError,
} from '@domain/errors/DomainError';
import { RepositorySummaryDto } from '../dto/Dto';

/**
 * Register a GitHub repo by URL. Idempotent on (owner, name): if the repo
 * already exists, the cached row is returned. The caller is expected to
 * follow up with AnalyzeRepositoryCoverage to populate coverage data.
 */
export class RegisterRepository {
  constructor(
    private readonly repos: RepositoryRepository,
    private readonly github: GitHubPort,
  ) {}

  async execute(input: { url: string }): Promise<RepositorySummaryDto> {
    const { owner, name } = Repository.parseUrl(input.url);

    const existing = await this.repos.findByOwnerAndName(owner, name);
    if (existing) {
      return this.toDto(existing);
    }

    const meta = await this.github
      .getRepositoryMeta(owner, name)
      .catch((e: Error) => {
        throw new UpstreamRepoUnreachableError(`${owner}/${name}`, e.message);
      });
    if (!meta.forkingAllowed) {
      throw new ForkingDisabledError(`${owner}/${name}`);
    }
    const repo = Repository.create({ owner, name, defaultBranch: meta.defaultBranch });
    await this.repos.save(repo);
    return this.toDto(repo);
  }

  private toDto(repo: Repository): RepositorySummaryDto {
    return {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      forkOwner: repo.forkOwner,
      lastAnalyzedAt: repo.lastAnalyzedAt?.toISOString() ?? null,
      overallLinesPct: null,
      fileCount: 0,
    };
  }
}
