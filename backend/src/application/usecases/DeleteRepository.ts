import { RepositoryId } from '@domain/repository/RepositoryId';
import { RepositoryRepository } from '@domain/ports/RepositoryRepository';
import { RepositoryNotFoundError } from '@domain/errors/DomainError';

/**
 * Delete a registered repository and all dependent rows (coverage reports,
 * file coverages, jobs, job logs) via foreign-key cascade. The bot's GitHub
 * fork is intentionally left intact — it may have open PRs we don't want
 * to surprise-delete.
 */
export class DeleteRepository {
  constructor(private readonly repos: RepositoryRepository) {}

  async execute(input: { id: RepositoryId }): Promise<void> {
    const repo = await this.repos.findById(input.id);
    if (!repo) throw new RepositoryNotFoundError(input.id.value);
    await this.repos.delete(input.id);
  }
}
