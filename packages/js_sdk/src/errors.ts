/** Machine-readable kind of a {@link StrybokError}; survives duplicated copies of the package. */
export type StrybokErrorKind =
  'unsupported_link' | 'link_not_found' | 'network' | 'timeout' | 'server';

/** Base class of every error reported by the SDK. */
export abstract class StrybokError extends Error {
  abstract readonly kind: StrybokErrorKind;

  /** The link that was being handled, when known. */
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

  /** What the transport threw. */
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

  constructor(url?: string) {
    super('The resolve request timed out', url);
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
