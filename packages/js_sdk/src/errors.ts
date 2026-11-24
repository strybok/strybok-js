/** Machine-readable kind of a {@link StrybokError}; survives duplicated copies of the package. */
export type StrybokErrorKind =
  | 'unsupported_link'
  | 'link_not_found'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unauthorized'
  | 'route_not_allowed'
  | 'rate_limited'
  | 'validation';

/** Base class of every error reported by the SDK. */
export abstract class StrybokError extends Error {
  abstract readonly kind: StrybokErrorKind;

  /** The link that was being handled, when known. Never set by `createLink`. */
  readonly url: string | undefined;

  protected constructor(message: string, url?: string) {
    super(message);
    this.url = url;
  }
}

/**
 * The URL is not a Strybok link of this app: wrong scheme, a host outside `allowedHosts`, or a
 * path that is not a single slug.
 */
export class UnsupportedLinkError extends StrybokError {
  readonly kind = 'unsupported_link';

  constructor(message: string, url?: string) {
    super(message, url);
    this.name = 'UnsupportedLinkError';
  }
}

/** The service does not know this link, or it is disabled or expired. */
export class LinkNotFoundError extends StrybokError {
  readonly kind = 'link_not_found';

  constructor(url?: string) {
    super('No active link matches this URL', url);
    this.name = 'LinkNotFoundError';
  }
}

/** The request could not be completed (offline, DNS, connection reset) after all retries. */
export class StrybokNetworkError extends StrybokError {
  readonly kind = 'network';

  /**
   * What the transport threw. Not set by `createLink`: a transport's error may hold the request,
   * and with it the client key and the payload.
   */
  readonly cause: unknown;

  constructor(message: string, url?: string, cause?: unknown) {
    super(message, url);
    this.name = 'StrybokNetworkError';
    this.cause = cause;
  }
}

/** The service did not answer in time, after all retries. */
export class StrybokTimeoutError extends StrybokError {
  readonly kind = 'timeout';

  constructor(url?: string, message = 'The resolve request timed out') {
    super(message, url);
    this.name = 'StrybokTimeoutError';
  }
}

/** The service answered with an unexpected status code or body. */
export class StrybokServerError extends StrybokError {
  readonly kind = 'server';

  readonly statusCode: number;

  constructor(message: string, statusCode: number, url?: string) {
    super(message, url);
    this.name = 'StrybokServerError';
    this.statusCode = statusCode;
  }
}

/**
 * `createLink` was refused: no `clientKey` is configured (no request is made), or the service
 * answered 401 because the key is wrong or was replaced, or the owner switched the feature off.
 * The service does not say which.
 */
export class StrybokUnauthorizedError extends StrybokError {
  readonly kind = 'unauthorized';

  constructor(message: string) {
    super(message);
    this.name = 'StrybokUnauthorizedError';
  }
}

/** 403 from `createLink`: the route is not covered by the application's route patterns. */
export class RouteNotAllowedError extends StrybokError {
  readonly kind = 'route_not_allowed';

  /** The route that was asked for. */
  readonly routePath: string;

  constructor(routePath: string) {
    super('This route is not covered by the route patterns of the application');
    this.name = 'RouteNotAllowedError';
    this.routePath = routePath;
  }
}

/**
 * 429 from `createLink`: too many requests from this device's address or for this app, or the
 * app's daily limit of new links is reached. Never retried automatically.
 */
export class StrybokRateLimitedError extends StrybokError {
  readonly kind = 'rate_limited';

  /** Seconds to wait before trying again, from the `Retry-After` header, when the service sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(retryAfterSeconds?: number) {
    super('Too many link creation requests');
    this.name = 'StrybokRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** One problem reported by the service for a rejected `createLink` request. */
export interface StrybokValidationIssue {
  /** The field, e.g. `title` or `payload`. */
  readonly path: string;
  readonly message: string;
}

/**
 * The arguments of `createLink` were rejected: by the SDK before sending, or by the service
 * (400, 413, 422).
 */
export class StrybokValidationError extends StrybokError {
  readonly kind = 'validation';

  /** The status the service answered with; `undefined` when the SDK rejected the call itself. */
  readonly statusCode: number | undefined;

  /** What the service reported per field (`error.details.issues`); empty when it reported none. */
  readonly issues: readonly StrybokValidationIssue[];

  constructor(
    message: string,
    statusCode?: number,
    issues: readonly StrybokValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'StrybokValidationError';
    this.statusCode = statusCode;
    this.issues = issues;
  }
}
