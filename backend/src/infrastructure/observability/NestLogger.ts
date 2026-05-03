import { Logger as NestCommonLogger } from '@nestjs/common';
import { Logger, LoggerFactory } from '@domain/ports/LoggerPort';

/**
 * `LoggerPort.Logger` implementation backed by NestJS's built-in Logger.
 * Thin pass-through — every method forwards to the same-named method on
 * the wrapped Nest logger. The point of the wrapper is purely architectural
 * (keeps `@nestjs/common` out of `domain/` and `application/`).
 */
class NestLoggerAdapter implements Logger {
  constructor(private readonly inner: NestCommonLogger) {}

  log(message: string, ...optionalParams: unknown[]): void {
    this.inner.log(message, ...optionalParams);
  }
  warn(message: string, ...optionalParams: unknown[]): void {
    this.inner.warn(message, ...optionalParams);
  }
  error(message: string, stack?: string, ...optionalParams: unknown[]): void {
    this.inner.error(message, stack, ...optionalParams);
  }
  debug(message: string, ...optionalParams: unknown[]): void {
    this.inner.debug(message, ...optionalParams);
  }
}

/**
 * `LoggerFactory` adapter that produces NestJS-backed scoped loggers.
 * Wired in `AppModule` under `TOKENS.LoggerFactory`; per-use-case providers
 * call `factory.create('UseCaseName')` to get the scoped instance the use
 * case takes via constructor injection.
 */
export class NestLoggerFactory implements LoggerFactory {
  create(scope: string): Logger {
    return new NestLoggerAdapter(new NestCommonLogger(scope));
  }
}
