import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { isOriginAllowed } from './cors.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      404,
      'NOT_FOUND',
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * Global Fastify error handler that formats all errors consistently.
 */
export function errorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const isAppError = error instanceof AppError;
  const isFastifyValidation = 'validation' in error;

  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: unknown = undefined;

  if (isAppError) {
    statusCode = error.statusCode;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (isFastifyValidation) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = error.message;
    details = (error as FastifyError).validation;
  } else if ('statusCode' in error && typeof error.statusCode === 'number') {
    statusCode = error.statusCode;
    code = (error as FastifyError).code || 'ERROR';
    message = error.message;
  } else if (
    // @fastify/rate-limit (and a few other plugins) throw errors whose shape
    // is `{ error: { code, message, details } }` without a top-level statusCode.
    // Without this branch we'd default to 500 and log "Internal server error"
    // for every rate-limit hit, which is noise.
    typeof (error as unknown as Record<string, unknown>).error === 'object' &&
    (error as unknown as Record<string, unknown>).error !== null
  ) {
    const nested = (error as unknown as { error: Record<string, unknown> }).error;
    code = typeof nested.code === 'string' ? nested.code : 'ERROR';
    message = typeof nested.message === 'string' ? nested.message : error.message;
    details = nested.details;
    statusCode = code === 'RATE_LIMIT_EXCEEDED' ? 429 : 400;
  }

  if (statusCode >= 500) {
    request.log.error({ err: error }, 'Internal server error');
  }

  // Ensure CORS headers are present on error responses
  const origin = request.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Vary', 'Origin');
  }

  reply.status(statusCode).send({
    error: { code, message, details },
  });
}
