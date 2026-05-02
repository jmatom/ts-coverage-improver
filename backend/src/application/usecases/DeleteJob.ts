import { JobRepository } from '@domain/ports/JobRepository';
import {
  CannotDeleteInFlightJobError,
  JobNotFoundError,
} from '@domain/errors/DomainError';

/**
 * Delete a single improvement job and its logs. Refuses to delete jobs that
 * are still pending or running — those reflect in-flight work that hasn't
 * yet produced a stable outcome (PR opened, fork pushed, etc). Wait for
 * terminal status (succeeded / failed) before cleaning up.
 */
export class DeleteJob {
  constructor(private readonly jobs: JobRepository) {}

  async execute(input: { id: string }): Promise<void> {
    const job = await this.jobs.findById(input.id);
    if (!job) throw new JobNotFoundError(input.id);
    if (!job.isTerminal()) {
      throw new CannotDeleteInFlightJobError(job.id);
    }
    await this.jobs.delete(input.id);
  }
}
