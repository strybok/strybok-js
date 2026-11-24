/**
 * Strybok SDK core for JavaScript runtimes.
 *
 * Receives verified HTTPS links (iOS Universal Links / Android App Links) from a pluggable
 * `LinkSource`, resolves them through the Strybok API and delivers every link exactly once. It can
 * also create short links to share (`createLink`).
 *
 * Deferred deep linking (restoring a link after the app is installed from a store) is not
 * supported.
 */
export { Strybok } from './strybok.js';
export {
  LinkNotFoundError,
  RouteNotAllowedError,
  StrybokError,
  StrybokNetworkError,
  StrybokRateLimitedError,
  StrybokServerError,
  StrybokTimeoutError,
  StrybokUnauthorizedError,
  StrybokValidationError,
  UnsupportedLinkError,
} from './errors.js';
export type { StrybokErrorKind, StrybokValidationIssue } from './errors.js';
export type {
  CreatedLink,
  CreateLinkOptions,
  FetchLike,
  FetchRequestInit,
  FetchResponseLike,
  LinkErrorHandler,
  LinkListener,
  LinkSource,
  ResolvedLink,
  StrybokOptions,
  StrybokPlatform,
  Unsubscribe,
} from './types.js';
export { SDK_VERSION } from './version.js';
