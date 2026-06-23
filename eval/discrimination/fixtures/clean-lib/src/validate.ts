import { ValidationError } from "./errors.js";
import { logDebug } from "./logger.js";
import type { PageRequest } from "./types.js";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(trimmed)) {
    throw new ValidationError("email", `invalid email address: ${email}`);
  }
  logDebug("validated email", { email: trimmed });
  return trimmed;
}

export function validateDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length < 2 || trimmed.length > 64) {
    throw new ValidationError("displayName", "display name must be 2-64 characters");
  }
  logDebug("validated display name", { length: trimmed.length });
  return trimmed;
}

export function validatePageRequest(request: PageRequest): PageRequest {
  if (request.limit < 1 || request.limit > 100) {
    throw new ValidationError("limit", "limit must be between 1 and 100");
  }
  if (request.offset < 0) {
    throw new ValidationError("offset", "offset must be non-negative");
  }
  return request;
}
