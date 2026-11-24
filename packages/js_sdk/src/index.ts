/**
 * Strybok SDK core for JavaScript runtimes.
 *
 * Receives verified HTTPS links (iOS Universal Links / Android App Links) from a pluggable
 * `LinkSource`, resolves them through the Strybok API and delivers every link exactly once.
 *
 * Deferred deep linking (restoring a link after the app is installed from a store) is not
 * supported.
 */
export { Strybok } from './strybok.js';
export {
  LinkNotFoundError,
  StrybokError,
  StrybokNetworkError,
  StrybokServerError,
  StrybokTimeoutError,
  UnsupportedLinkError,
} from './errors.js';
export type { StrybokErrorKind } from './errors.js';
export type {
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
