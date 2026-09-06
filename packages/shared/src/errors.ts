// PR3: packages/shared — Domain-neutral Error Primitives
//
// Generic, domain-neutral error abstractions that any layer may build upon.
// Specific errors (AnthropicError, PrismaError, DockerError, MCPError,
// ElectronError) strictly belong to their respective package boundaries.

export interface ErrorOptions {
  cause?: unknown;
  details?: unknown;
}

/**
 * Base class for all structured application errors across the repository.
 */
export class BaseError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      stack: this.stack,
    };
  }
}

export class ValidationError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("VALIDATION_ERROR", message, options);
  }
}

export class NotFoundError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("NOT_FOUND", message, options);
  }
}

export class InvalidArgumentError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_ARGUMENT", message, options);
  }
}

export class TimeoutError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("TIMEOUT", message, options);
  }
}

export class CancelledError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("CANCELLED", message, options);
  }
}

export class ConflictError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFLICT", message, options);
  }
}

export class InternalError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("INTERNAL", message, options);
  }
}

/**
 * Type guard for BaseError instances.
 */
export function isBaseError(value: unknown): value is BaseError {
  return value instanceof BaseError;
}

/**
 * Safely converts any caught unknown value into a standard Error instance.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) {
    return thrown;
  }
  if (typeof thrown === "string") {
    return new Error(thrown);
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "message" in thrown &&
    typeof (thrown as { message: unknown }).message === "string"
  ) {
    return new Error((thrown as { message: string }).message);
  }
  return new Error(String(thrown));
}

/**
 * Formats an unknown error or thrown value into a readable string message.
 */
export function formatError(err: unknown): string {
  if (err instanceof BaseError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
