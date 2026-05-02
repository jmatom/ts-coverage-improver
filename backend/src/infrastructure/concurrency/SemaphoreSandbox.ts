import {
  SandboxPort,
  SandboxRunInput,
  SandboxRunResult,
} from '@domain/ports/SandboxPort';
import { Semaphore } from './Semaphore';

/**
 * Decorator over `SandboxPort` that funnels all `run` calls through a
 * Semaphore. When the cap is reached, additional calls await a free slot
 * (FIFO). `assertReady` is not gated — it's a fast health check and gating
 * it would block boot validation behind in-flight jobs.
 *
 * The wrapped port still owns the actual lifecycle (create / start / wait /
 * remove). The wrapper is purely admission control.
 */
export class SemaphoreSandbox implements SandboxPort {
  constructor(
    private readonly inner: SandboxPort,
    private readonly sem: Semaphore,
  ) {}

  assertReady(): Promise<void> {
    return this.inner.assertReady();
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const release = await this.sem.acquire();
    try {
      return await this.inner.run(input);
    } finally {
      release();
    }
  }
}
