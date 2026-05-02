import {
  AICliPort,
  GenerateTestInput,
  GenerateTestOutput,
} from '@domain/ports/AICliPort';
import { Semaphore } from './Semaphore';

/**
 * Decorator over `AICliPort` that gates `generateTest` calls behind a
 * Semaphore. Distinct from the sandbox cap because AI throughput is bounded
 * by the API key's rate limit / billing, not by host capacity.
 *
 * `id`, `requiredEnv`, `optionalEnv` are forwarded so AppModule's adapter
 * registry can still introspect them at boot.
 */
export class SemaphoreAiAdapter implements AICliPort {
  constructor(
    private readonly inner: AICliPort,
    private readonly sem: Semaphore,
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get requiredEnv(): readonly string[] {
    return this.inner.requiredEnv;
  }
  get optionalEnv(): readonly string[] {
    return this.inner.optionalEnv;
  }

  async generateTest(input: GenerateTestInput): Promise<GenerateTestOutput> {
    const release = await this.sem.acquire();
    try {
      return await this.inner.generateTest(input);
    } finally {
      release();
    }
  }
}
