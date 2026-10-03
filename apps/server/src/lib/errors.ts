export interface AppErrorOptions {
  status?: number;
  cause?: unknown;
  /** Whether `message` is safe to show to clients. Defaults to true for 4xx. */
  expose?: boolean;
  details?: Record<string, unknown>;
}

/**
 * Base class for every error we raise on purpose. `code` is stable and part of the
 * API contract (it ends up in problem+json responses), so never rename an existing code.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? this.status < 500;
    this.details = options.details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', options: Omit<AppErrorOptions, 'status'> = {}) {
    super('NOT_FOUND', message, { ...options, status: 404 });
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'status'> = {}) {
    super('BAD_REQUEST', message, { ...options, status: 400 });
  }
}

/** No valid session. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options: Omit<AppErrorOptions, 'status'> = {}) {
    super('UNAUTHORIZED', message, { ...options, status: 401 });
  }
}

/**
 * Signed in and a member, but the role does not allow the action. Never use this for resources the
 * caller cannot see at all: those are 404 so existence is not leaked.
 */
export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to do this',
    options: Omit<AppErrorOptions, 'status'> & { code?: string } = {},
  ) {
    super(options.code ?? 'FORBIDDEN', message, { ...options, status: 403 });
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, options: Omit<AppErrorOptions, 'status'> = {}) {
    super(code, message, { ...options, status: 409 });
  }
}

/** A transient failure (network blip, rate limit, dependency down). Workers retry it with backoff. */
export class RetryableError extends AppError {
  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(code, message, { status: 503, ...options });
  }
}

/** A failure that can never succeed on retry (bad input, missing resource). Workers fail the job immediately. */
export class PermanentError extends AppError {
  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(code, message, { status: 422, ...options });
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
