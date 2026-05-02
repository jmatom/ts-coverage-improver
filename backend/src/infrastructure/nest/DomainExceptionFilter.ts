import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '@domain/errors/DomainError';

/**
 * Maps DomainError subclasses to friendly HTTP responses.
 *
 * Rationale: when a use case throws something we *expected* — unsupported
 * test framework, repo not reachable, file not in latest report — we want
 * the client to get a clear 4xx with a stable `code` they can act on, not
 * a generic 500. Generic `Error` instances and unknown throws fall through
 * to NestJS's default exception handler (still 500).
 *
 * Response shape:
 *   {
 *     "code": "UNSUPPORTED_TEST_FRAMEWORK",
 *     "message": "Unsupported test framework: expected one of jest/vitest/mocha …",
 *     "statusCode": 422
 *   }
 *
 * Codes are domain-stable; status is the infra mapping. Add a new entry to
 * `HTTP_STATUS_BY_CODE` when you add a new DomainError subclass.
 */
const HTTP_STATUS_BY_CODE: Record<string, number> = {
  // 400 — request shape was wrong
  INVALID_GITHUB_URL: 400,

  // 404 — aggregate not found
  REPOSITORY_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,

  // 422 — request was valid but the system can't satisfy it given current state
  MISSING_PACKAGE_JSON: 422,
  UNSUPPORTED_TEST_FRAMEWORK: 422,
  MISSING_MOCHA_COVERAGE_TOOL: 422,
  FORKING_DISABLED: 422,
  NO_COVERAGE_REPORT: 422,
  FILE_NOT_IN_REPORT: 422,
  FILE_ALREADY_AT_100_PERCENT: 422,

  // 409 — idempotency conflict: the requested operation is already happening
  JOB_ALREADY_IN_FLIGHT: 409,
  CANNOT_DELETE_IN_FLIGHT_JOB: 409,

  // 502 — third-party API problem (GitHub unreachable, etc.)
  UPSTREAM_UNREACHABLE: 502,

  // 503 — admission control: system is at capacity, retry later
  QUEUE_DEPTH_EXCEEDED: 503,
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DomainExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof DomainError) {
      const status = HTTP_STATUS_BY_CODE[exception.code] ?? 422;
      res.status(status).json({
        code: exception.code,
        message: exception.message,
        statusCode: status,
      });
      return;
    }

    // Let NestJS-native HttpException pass through unchanged (we still
    // use NotFoundException etc. in controllers).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      res.status(status).json(payload);
      return;
    }

    // Unknown error → still log to backend for debugging, but don't leak the
    // stack trace to the client.
    const err = exception as Error;
    this.logger.error(`Unhandled error: ${err?.message}`, err?.stack);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      statusCode: 500,
    });
  }
}
