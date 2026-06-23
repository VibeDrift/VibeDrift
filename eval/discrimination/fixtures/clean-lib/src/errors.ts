// Shared error types. Every module throws these and catches them consistently.

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export class NotFoundError extends Error {
  readonly resource: string;

  constructor(resource: string, message: string) {
    super(message);
    this.name = "NotFoundError";
    this.resource = resource;
  }
}

export function isValidationError(value: unknown): value is ValidationError {
  return value instanceof ValidationError;
}

export function isNotFoundError(value: unknown): value is NotFoundError {
  return value instanceof NotFoundError;
}
