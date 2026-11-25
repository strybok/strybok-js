/**
 * Strybok SDK core for JavaScript runtimes.
 *
 * Receives verified HTTPS links (iOS Universal Links / Android App Links) from a pluggable
 * `LinkSource`, resolves them through the Strybok API and delivers every link exactly once. It can
 * also create short links to share (`createLink`).
 *
 * Deferred links (restoring a link after the app is installed from a store) are optional and off
 * by default (`deferredLinks`). This package has no native code: on Android the app supplies the
 * install referrer through `installReferrerSources`, on iOS it passes what the person pasted to
 * `redeemPastedLink`. In a browser there is nothing to restore and the option does nothing.
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
  DeferredLinkStatus,
  DeferredLinkStatusListener,
  DeferredLinkStore,
  FetchLike,
  FetchRequestInit,
  FetchResponseLike,
  InstallReferrerAnswer,
  InstallReferrerSource,
  LinkCampaign,
  LinkErrorHandler,
  LinkListener,
  LinkSource,
  PastedLinkResult,
  ResolvedLink,
  StrybokOptions,
  StrybokPlatform,
  Unsubscribe,
} from './types.js';
export { SDK_VERSION } from './version.js';
