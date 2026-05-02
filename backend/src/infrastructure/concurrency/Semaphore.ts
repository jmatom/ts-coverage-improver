/**
 * Tiny async counting semaphore.
 *
 * `acquire()` resolves when a slot is free and returns a `release` function
 * that **must** be called when the work is done — typically in a `finally`
 * block. Multiple awaiters are served FIFO.
 *
 * Used by the SemaphoreSandbox and SemaphoreAiAdapter wrappers to enforce
 * global caps on:
 *   - simultaneous sandbox container spawns (MAX_CONCURRENT_SANDBOXES)
 *   - simultaneous AI invocations (MAX_CONCURRENT_AI_CALLS)
 *
 * The two are kept separate because the bottlenecks are different:
 *   - Sandbox capacity is host-bound (memory, disk, Docker daemon throughput).
 *   - AI capacity is account-bound (Anthropic rate limit / credit cost).
 *
 * A 16-core box can comfortably run 8 sandboxes for `npm install` + tests but
 * still cannot safely fan 8 jobs into Claude in parallel, because the rate
 * limit is on the API key, not the box.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(public readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be a positive integer; got ${max}`);
    }
  }

  /**
   * Resolves with a release fn once a slot is free. The release fn is
   * idempotent — calling it more than once is a no-op. This guards against
   * accidental double-release (e.g. a `try/finally` that's also called from
   * an outer error path) silently driving `inFlight` below zero and
   * corrupting the cap.
   */
  async acquire(): Promise<() => void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /** For diagnostics / metrics. */
  get currentInFlight(): number {
    return this.inFlight;
  }
  get currentWaiting(): number {
    return this.waiters.length;
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
