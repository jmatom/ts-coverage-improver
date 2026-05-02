import { ImprovementJob } from '@domain/job/ImprovementJob';
import { JobRepository } from '@domain/ports/JobRepository';
import { CoverageReportRepository } from '@domain/ports/CoverageReportRepository';
import { JobScheduler } from '@domain/services/JobScheduler';
import {
  FileAlreadyFullyCoveredError,
  FileNotInLatestReportError,
  JobAlreadyInFlightError,
  NoCoverageReportError,
  QueueDepthExceededError,
} from '@domain/errors/DomainError';
import { JobDto } from '../dto/Dto';
import { jobToDto } from './_jobMapping';

export interface RequestImprovementJobOptions {
  /**
   * Maximum number of jobs allowed in non-terminal status (pending+running)
   * across the whole system. Beyond this, new requests are rejected with
   * `QueueDepthExceededError` (HTTP 503). 0 / undefined disables the cap.
   */
  maxQueueDepth?: number;
}

/**
 * Validate the requested file exists in the latest coverage report, then
 * persist a pending job and enqueue it. The scheduler enforces per-repo
 * serialization (spec NFR).
 *
 * Backpressure: if the global pending+running count meets `maxQueueDepth`,
 * we reject with a 503 instead of queueing. This prevents the in-memory
 * queue from growing unboundedly under bursty fan-out (e.g. all 30 repos
 * receiving a "queue every low-coverage file" command at once).
 */
export class RequestImprovementJob {
  private readonly maxQueueDepth: number;

  constructor(
    private readonly jobs: JobRepository,
    private readonly reports: CoverageReportRepository,
    private readonly scheduler: JobScheduler,
    options: RequestImprovementJobOptions = {},
  ) {
    this.maxQueueDepth = options.maxQueueDepth ?? 0;
  }

  async execute(input: {
    repositoryId: string;
    targetFilePath: string;
  }): Promise<JobDto> {
    const latest = await this.reports.findLatestByRepository(input.repositoryId);
    if (!latest) {
      throw new NoCoverageReportError(input.repositoryId);
    }
    const fileCov = latest.fileFor(input.targetFilePath);
    if (!fileCov) {
      throw new FileNotInLatestReportError(input.targetFilePath);
    }
    if (fileCov.linesPct >= 100) {
      throw new FileAlreadyFullyCoveredError(input.targetFilePath);
    }
    // Idempotency guard: refuse to queue a duplicate job for a file that
    // already has one pending or running. The UI also disables the button,
    // but a fast double-click or a direct API call would otherwise slip
    // through and produce two PRs racing on the same source file.
    const inFlight = await this.jobs.findInFlightForFile(
      input.repositoryId,
      input.targetFilePath,
    );
    if (inFlight) {
      throw new JobAlreadyInFlightError(input.targetFilePath, inFlight.id);
    }
    // Admission control. Checked AFTER the per-file idempotency guard so
    // that retrying the same file when a job is already in flight returns
    // 409 (clearer signal) rather than 503.
    if (this.maxQueueDepth > 0) {
      const active = await this.jobs.countActive();
      if (active >= this.maxQueueDepth) {
        throw new QueueDepthExceededError(active, this.maxQueueDepth);
      }
    }
    const job = ImprovementJob.create({
      repositoryId: input.repositoryId,
      targetFilePath: input.targetFilePath,
    });
    await this.jobs.save(job);
    await this.scheduler.enqueue(job);
    return jobToDto(job);
  }
}
