/**
 * Application-layer port: invoked by the JobScheduler to actually execute
 * an enqueued improvement job. The Day-2 RunImprovementJob implements this.
 *
 * The executor owns its own state transitions on the job aggregate; the
 * queue only enforces per-repo serialization. Errors that escape execute()
 * are caught by the queue as a safety net.
 */
export interface JobExecutor {
  execute(jobId: string): Promise<void>;
}
