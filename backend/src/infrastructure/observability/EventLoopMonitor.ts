import { Logger } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Background watcher for event-loop stalls.
 *
 * Sets up a `monitorEventLoopDelay` histogram (10 ms resolution) and polls
 * its `max` once per second. Whenever the worst-case stall in the past
 * window exceeds the threshold (default 50 ms), emits a warning and resets
 * the histogram. Otherwise stays silent — no log spam for healthy runs.
 *
 * Why we care: this backend orchestrates Docker, runs in-process AST/TS
 * parsing, and synchronous SQLite calls. Most work is I/O and stays off
 * the loop, but a runaway AST validation or a giant lcov could cause
 * head-of-line blocking that delays health checks and HTTP responses.
 * This monitor is the early warning before users notice anything.
 *
 * Implementation: returns a `stop()` for the test/teardown path. In
 * production this lives for the process lifetime; we don't shut it down
 * because Nest's onModuleDestroy isn't reliable enough during crash exit.
 */
export interface EventLoopMonitorOptions {
  /** Stall threshold in milliseconds. Logs a warn when max delay exceeds this. */
  thresholdMs?: number;
  /** How often to inspect + reset the histogram, in milliseconds. */
  pollMs?: number;
  /** Histogram resolution in milliseconds. Lower = finer measurements, higher CPU. */
  resolutionMs?: number;
}

export function startEventLoopMonitor(opts: EventLoopMonitorOptions = {}): () => void {
  const thresholdMs = opts.thresholdMs ?? 50;
  const pollMs = opts.pollMs ?? 1000;
  const resolutionMs = opts.resolutionMs ?? 10;

  const logger = new Logger('EventLoopMonitor');
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const handle = setInterval(() => {
    // `max` is in nanoseconds. Convert to ms; check; reset for the next window.
    const maxMs = histogram.max / 1_000_000;
    if (maxMs >= thresholdMs) {
      const meanMs = histogram.mean / 1_000_000;
      const p99Ms = histogram.percentile(99) / 1_000_000;
      logger.warn(
        `Event loop stalled: max=${maxMs.toFixed(1)}ms p99=${p99Ms.toFixed(1)}ms ` +
          `mean=${meanMs.toFixed(2)}ms (threshold=${thresholdMs}ms, window=${pollMs}ms)`,
      );
    }
    histogram.reset();
  }, pollMs);
  // Don't keep the process alive solely for this monitor.
  handle.unref();

  logger.log(
    `Event loop monitor started — warn on stalls ≥ ${thresholdMs}ms (poll ${pollMs}ms, resolution ${resolutionMs}ms)`,
  );

  return function stop() {
    clearInterval(handle);
    histogram.disable();
  };
}
