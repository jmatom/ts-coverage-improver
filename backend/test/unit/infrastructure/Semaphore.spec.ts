import { Semaphore } from '../../../src/infrastructure/concurrency/Semaphore';

describe('Semaphore', () => {
  it('rejects invalid max', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it('lets `max` acquires resolve immediately', async () => {
    const sem = new Semaphore(3);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    const r3 = await sem.acquire();
    expect(sem.currentInFlight).toBe(3);
    r1();
    r2();
    r3();
    expect(sem.currentInFlight).toBe(0);
  });

  it('queues acquires past `max`, releases serve FIFO', async () => {
    const sem = new Semaphore(2);
    const order: string[] = [];

    // Two acquires fill the slots immediately.
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();

    // Two more must wait. They resolve in the order they were enqueued.
    const p3 = sem.acquire().then((r) => {
      order.push('3-acquired');
      return r;
    });
    const p4 = sem.acquire().then((r) => {
      order.push('4-acquired');
      return r;
    });

    expect(sem.currentInFlight).toBe(2);
    expect(sem.currentWaiting).toBe(2);

    // Release one slot → only the first waiter wakes.
    r1();
    const r3 = await p3;
    expect(order).toEqual(['3-acquired']);
    expect(sem.currentInFlight).toBe(2);
    expect(sem.currentWaiting).toBe(1);

    // Release another → second waiter wakes.
    r2();
    const r4 = await p4;
    expect(order).toEqual(['3-acquired', '4-acquired']);

    r3();
    r4();
    expect(sem.currentInFlight).toBe(0);
  });

  it('release fn is idempotent — second call is a no-op', async () => {
    const sem = new Semaphore(1);
    const r = await sem.acquire();
    expect(sem.currentInFlight).toBe(1);
    r();
    expect(sem.currentInFlight).toBe(0);
    r(); // second call should not drive inFlight below zero
    expect(sem.currentInFlight).toBe(0);
    // Acquiring again should still work after the spurious double-release.
    const r2 = await sem.acquire();
    expect(sem.currentInFlight).toBe(1);
    r2();
  });

  it('double-release does not wake a waiter twice', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    let wakeups = 0;
    const p = sem.acquire().then((r) => {
      wakeups++;
      return r;
    });
    r1();
    r1(); // second call must NOT wake another waiter
    const r2 = await p;
    // Allow the microtask queue to fully drain.
    await new Promise((res) => setImmediate(res));
    expect(wakeups).toBe(1);
    r2();
  });
});
