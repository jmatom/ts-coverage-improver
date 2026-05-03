/**
 * Domain port for logging. Use cases consume this; infrastructure provides
 * the adapter (today: `NestLogger`, wrapping `@nestjs/common`'s Logger).
 *
 * The point: keeps `domain/` and `application/` free of NestJS imports so
 * the layering rule documented in CLAUDE.md ("domain + application import
 * zero framework code") holds without an asterisk for logging.
 *
 * Method shapes mirror the subset of `@nestjs/common` Logger that the
 * existing call sites use, so the adapter is a one-liner per method.
 */
export interface Logger {
  log(message: string, ...optionalParams: unknown[]): void;
  warn(message: string, ...optionalParams: unknown[]): void;
  /**
   * @param stack — optional captured stack trace for error correlation.
   *   Pass `(e as Error).stack` when wrapping a thrown exception. Omit
   *   for plain error messages.
   */
  error(message: string, stack?: string, ...optionalParams: unknown[]): void;
  debug(message: string, ...optionalParams: unknown[]): void;
}

/**
 * Factory for creating per-scope loggers. Each use case typically owns
 * one scope (its class name); the factory mirrors the `new Logger(scope)`
 * pattern at the port level so DI wiring can inject a pre-scoped instance
 * into each use case without the use case knowing how scoping works.
 */
export interface LoggerFactory {
  create(scope: string): Logger;
}
