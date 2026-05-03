import { InMemoryPerRepoQueue } from '../../../src/infrastructure/queue/InMemoryPerRepoQueue';
import { ImprovementJob } from '../../../src/domain/job/ImprovementJob';
import { JobId } from '../../../src/domain/job/JobId';
import { RepositoryId } from '../../../src/domain/repository/RepositoryId';
import { JobRepository } from '../../../src/domain/ports/JobRepository';
import { JobStatus } from '../../../src/domain/job/JobStatus';
import { JobExecutor } from '../../../src/application/usecases/JobExecutor';

class FakeJobs implements JobRepository {
  rows = new Map<string, ImprovementJob>();
  async save(j: ImprovementJob): Promise<void> {
    this.rows.set(j.id.value, j);
  }
  async findById(id: JobId): Promise<ImprovementJob | null> {
    return this.rows.get(id.value) ?? null;
  }
  async listByRepository(): Promise<ImprovementJob[]> {
    return [];
  }
  async findByStatus(_s: JobStatus): Promise<ImprovementJob[]> {
    return [];
  }
  async findInFlightForFile(): Promise<ImprovementJob | null> {
    return null;
  }
  async countActive(): Promise<number> {
    return 0;
  }
  async appendLog(): Promise<void> {}
  async delete(): Promise<void> {}
  async readLogs(): Promise<string[]> {
    return [];
  }
}

describe('InMemoryPerRepoQueue', () => {
  it('serializes jobs within the same repo', async () => {
    const r1 = RepositoryId.new();
    const order: string[] = [];
    const jobs = new FakeJobs();
    const exec: JobExecutor = {
      async execute(jobId: JobId) {
        order.push(`start:${jobId.value}`);
        await new Promise((res) => setTimeout(res, 20));
        order.push(`end:${jobId.value}`);
      },
    };
    const queue = new InMemoryPerRepoQueue(exec, jobs);

    const a = ImprovementJob.create({ repositoryId: r1, targetFilePath: 'a.ts' });
    const b = ImprovementJob.create({ repositoryId: r1, targetFilePath: 'b.ts' });
    await jobs.save(a);
    await jobs.save(b);

    await queue.enqueue(a);
    await queue.enqueue(b);
    await queue.waitForIdle(r1);

    expect(order).toEqual([
      `start:${a.id.value}`,
      `end:${a.id.value}`,
      `start:${b.id.value}`,
      `end:${b.id.value}`,
    ]);
  });

  it('runs jobs across different repos concurrently', async () => {
    const r1 = RepositoryId.new();
    const r2 = RepositoryId.new();
    const startedAt: Record<string, number> = {};
    const jobs = new FakeJobs();
    const exec: JobExecutor = {
      async execute(jobId: JobId) {
        startedAt[jobId.value] = Date.now();
        await new Promise((res) => setTimeout(res, 30));
      },
    };
    const queue = new InMemoryPerRepoQueue(exec, jobs);

    const a = ImprovementJob.create({ repositoryId: r1, targetFilePath: 'a.ts' });
    const b = ImprovementJob.create({ repositoryId: r2, targetFilePath: 'b.ts' });
    await jobs.save(a);
    await jobs.save(b);
    await queue.enqueue(a);
    await queue.enqueue(b);
    await Promise.all([queue.waitForIdle(r1), queue.waitForIdle(r2)]);

    // Both should have started within a small window of each other (concurrent).
    expect(Math.abs(startedAt[a.id.value] - startedAt[b.id.value])).toBeLessThan(20);
  });

  it('marks job failed if executor throws and job is non-terminal', async () => {
    const r1 = RepositoryId.new();
    const jobs = new FakeJobs();
    const exec: JobExecutor = {
      async execute() {
        throw new Error('boom');
      },
    };
    const queue = new InMemoryPerRepoQueue(exec, jobs);

    const j = ImprovementJob.create({ repositoryId: r1, targetFilePath: 'a.ts' });
    await jobs.save(j);
    await queue.enqueue(j);
    await queue.waitForIdle(r1);

    const fetched = await jobs.findById(j.id);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.error).toMatch(/boom/);
  });

  it('does not re-fail a job that the executor already failed', async () => {
    const r1 = RepositoryId.new();
    const jobs = new FakeJobs();
    const exec: JobExecutor = {
      async execute(jobId: JobId) {
        const j = await jobs.findById(jobId);
        j!.fail('explicit failure');
        await jobs.save(j!);
        throw new Error('post-failure throw');
      },
    };
    const queue = new InMemoryPerRepoQueue(exec, jobs);

    const j = ImprovementJob.create({ repositoryId: r1, targetFilePath: 'a.ts' });
    await jobs.save(j);
    await queue.enqueue(j);
    await queue.waitForIdle(r1);

    const fetched = await jobs.findById(j.id);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.error).toBe('explicit failure');
  });
});
