export class CartGenieError extends Error {
  readonly status: number;

  /** Validation errors keyed by dotted path, e.g. { "card.number": ["..."] }. */
  readonly errors: Record<string, string[]>;

  /** Parsed Retry-After header (seconds) when the API rate-limited the request (HTTP 429). */
  readonly retryAfterSeconds?: number;

  /** Underlying failure for network errors (the rejected fetch error). */
  readonly cause?: unknown;

  constructor(
    message: string,
    status: number,
    errors: Record<string, string[]> = {},
    options: { cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'CartGenieError';
    this.status = status;
    this.errors = errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.cause = options.cause;
  }

  get isValidationError(): boolean {
    return this.status === 422;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Dotted error keys expanded into a nested object so each message can be
   * attached to its form field: { card: { number: ["..."] } }.
   *
   * Built on null-prototype objects, and paths containing prototype-polluting
   * segments (__proto__, prototype, constructor) are dropped entirely.
   */
  fieldErrors(): Record<string, unknown> {
    const unsafeSegments = new Set(['__proto__', 'prototype', 'constructor']);
    const nested: Record<string, unknown> = Object.create(null);

    for (const [path, messages] of Object.entries(this.errors)) {
      const segments = path.split('.');

      if (segments.some((segment) => unsafeSegments.has(segment))) {
        continue;
      }

      let cursor = nested;

      segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
          cursor[segment] = messages;
          return;
        }

        if (typeof cursor[segment] !== 'object' || cursor[segment] === null || Array.isArray(cursor[segment])) {
          cursor[segment] = Object.create(null);
        }
        cursor = cursor[segment] as Record<string, unknown>;
      });
    }

    return nested;
  }
}

/** The API answered 2xx but the body was not the JSON the contract promises. */
export class CartGenieProtocolError extends CartGenieError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'CartGenieProtocolError';
  }
}

/** The request never reached the API (DNS, offline, CORS, abort). Inspect `cause`. */
export class CartGenieNetworkError extends CartGenieError {
  constructor(message: string, cause: unknown) {
    super(message, 0, {}, { cause });
    this.name = 'CartGenieNetworkError';
  }
}
