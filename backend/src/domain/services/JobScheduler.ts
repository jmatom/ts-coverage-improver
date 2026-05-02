import { ImprovementJob } from '../job/ImprovementJob';

/**
 * Domain service interface: enforces the per-repository serialization invariant
 * (spec NFR: "serialize jobs per repository"). Concrete implementation lives
 * in infrastructure (in-process queue, persisted to SQLite).
 */
export interface JobScheduler {
  enqueue(job: ImprovementJob): Promise<void>;
}
