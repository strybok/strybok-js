import type { StrybokError } from './errors.js';

/** Platform reported with `app_open` events. */
export type StrybokPlatform = 'ios' | 'android' | 'unknown';

/**
 * Campaign values of a resolved link: the link's defaults, overridden per value by the `utm_*`
 * parameters of the URL that was tapped (`utm_source` is `source`, and so on).
 *
 * A value that is not set is absent. They are labels chosen by whoever created or shared the
 * link, so use them for attribution only and never to decide what the user may see or do.
 */
export interface LinkCampaign {
  readonly source?: string;
  readonly medium?: string;
  readonly campaign?: string;
  readonly term?: string;
  readonly content?: string;
}

/**
 * A link resolved by the Strybok API.
 *
 * `routePath`, `payload` and `campaign` are plain data chosen by whoever created or shared the
 * link. Treat them like any other untrusted input: map them onto routes your app already knows,
 * never execute them.
 */
export interface ResolvedLink {
  /** The full URL that opened the app, exactly as received (query and fragment included). */
  readonly url: string;
  readonly linkId: string;
  readonly appId: string;
  /** In-app route, always starting with a single `/` (for example `/invite/abc123`). */
  readonly routePath: string;
  /** Decoded JSON object attached to the link; empty when none was set. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Campaign values of this open; never `null`, an empty object when there are none. */
  readonly campaign: LinkCampaign;
  /**
   * `true` when the link was restored after an installation (see `deferredLinks`), `false` for
   * a link that opened the app the normal way. For a deferred link `url` is the link's own URL.
   */
  readonly isDeferred: boolean;
  /**
   * `true` only for a link the server **guessed** from the network address (iOS probabilistic
   * matching, `allowProbabilisticMatching`). Such a link may belong to another person on the
   * same network: never sign anyone in, accept an invitation, apply a personal discount or show
   * personal content on the strength of it alone.
   */
  readonly isProbabilisticMatch: boolean;
}

/** A short link made by `createLink`. */
export interface CreatedLink {
  /** The short URL to share. */
  readonly url: string;
  readonly slug: string;
  /** The in-app route the link opens. */
  readonly routePath: string;
  readonly linkId: string;
}

/** The optional parts of a link made by `createLink`. Parts that are not given are not sent. */
export interface CreateLinkOptions {
  /** JSON object delivered to the app together with the route. */
  payload?: Readonly<Record<string, unknown>>;
  /** Title of the link preview. */
  title?: string;
  /** Description of the link preview. */
  description?: string;
  /** Public HTTPS URL of the image of the link preview. */
  imageUrl?: string;
}

/**
 * Where incoming link URLs come from. Platform adapters wrap the host framework's API; tests and
 * custom integrations provide their own.
 */
export interface LinkSource {
  /** The URL that launched the app (cold start), or `null`. */
  getInitialUrl(): Promise<string | null | undefined>;

  /**
   * Starts reporting URLs received while the app is running and returns a function that stops
   * it. A source may also report the launch URL here; the SDK de-duplicates it.
   */
  subscribe(listener: (url: string) => void): () => void;
}

/**
 * Where the deferred-link check stands. Nothing here is an error: most people who install an
 * app never tapped a link.
 *
 * - `disabled` — `deferredLinks` is off, the platform is neither Android nor iOS, or something
 *   the check needs was not passed (`deferredLinkStore`, `androidPackageName` / `iosBundleId`);
 * - `checking` — the check is running in this launch;
 * - `pending` — not finished in this launch (not started yet, or the store or the network was
 *   not reachable); a later launch tries again;
 * - `notFirstLaunch` — finished in an earlier launch;
 * - `unavailable` — no source is configured or none can ever answer on this device; on iOS
 *   also: probabilistic matching is off (only a pasted link can restore anything), or the
 *   device family or language is unknown;
 * - `noReferrer` — the store's referrer has no click id of ours (an ordinary install);
 * - `notFound` — the server refused: unknown, older than 24 hours, already used, another app's;
 * - `superseded` — a normal link of this app arrived first;
 * - `delivered` — the link was handed to the `onLink` listeners (or queued for them);
 * - `failed` — three launches could not finish the check, or the server's answer was unusable;
 * - `awaitingPaste` — iOS probabilistic matching waits for `redeemPastedLink` or
 *   `skipPastedLink`, because `pasteboardMayContainLink` answered `true`.
 */
export type DeferredLinkStatus =
  | 'disabled'
  | 'checking'
  | 'pending'
  | 'notFirstLaunch'
  | 'unavailable'
  | 'noReferrer'
  | 'notFound'
  | 'superseded'
  | 'delivered'
  | 'failed'
  | 'awaitingPaste';

export type DeferredLinkStatusListener = (status: DeferredLinkStatus) => void;

/** Result of `redeemPastedLink`. */
export type PastedLinkResult =
  'delivered' | 'notOurs' | 'notFound' | 'alreadyHandled' | 'disabled' | 'failed';

/**
 * What an install referrer source answers:
 *
 * - `referrer` — the raw install referrer string of the store the app was installed from,
 *   exactly as the store returned it (it may be empty);
 * - `unavailableForNow` — the store could not be asked; a later launch may succeed;
 * - `unavailable` — this store is not on the device, is too old, or its library is not in the
 *   app. Asking again is pointless.
 */
export type InstallReferrerAnswer =
  | { readonly status: 'referrer'; readonly referrer: string }
  | { readonly status: 'unavailableForNow' }
  | { readonly status: 'unavailable' };

/**
 * Asks one store for its install referrer. Written by the app (this SDK has no native code):
 * typically a few lines around a native module or plugin. It should not throw and must release
 * whatever connection it opened; an answer that takes longer than 10 seconds, a rejection and
 * anything that is not an {@link InstallReferrerAnswer} count as `unavailableForNow`.
 */
export type InstallReferrerSource = () => InstallReferrerAnswer | Promise<InstallReferrerAnswer>;

/**
 * A small persistent key-value store for the two values the deferred-link check keeps per
 * installation (`strybok.deferred.attempts` and `strybok.deferred.done`). It must survive
 * restarts of the app and be removed with the app's data. AsyncStorage-style stores (promises)
 * and a web `Storage` (synchronous) have this shape; anything else needs a two-function wrapper.
 */
export interface DeferredLinkStore {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): unknown;
}

export type LinkListener = (link: ResolvedLink) => void;
export type LinkErrorHandler = (error: StrybokError) => void;
export type Unsubscribe = () => void;

/** The part of a `fetch` request the SDK uses. */
export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /**
   * An `AbortSignal` when the runtime has `AbortController`. Typed loosely so that both the
   * global `fetch` and hand-written transports are assignable without DOM typings.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signal?: any;
}

/** The part of a `fetch` response the SDK uses. */
export interface FetchResponseLike {
  readonly status: number;
  /**
   * Response headers. Optional, and only `Retry-After` of a 429 answer to `createLink` is read;
   * without it `StrybokRateLimitedError.retryAfterSeconds` is `undefined`.
   */
  readonly headers?: { get(name: string): string | null | undefined } | null;
  text(): Promise<string>;
}

/** HTTP transport. The global `fetch` satisfies it; so does a few lines around any HTTP client. */
export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

export interface StrybokOptions {
  /** Base URL of the Strybok API, e.g. `https://api.strybok.com`. A path prefix is preserved. */
  apiBaseUrl: string;

  /** Link hostnames of this app (bare hostnames, no scheme). Links on any other host are ignored. */
  allowedHosts: Iterable<string>;

  /** Where incoming URLs come from. */
  linkSource: LinkSource;

  /** Reported with `app_open` events. Default `'unknown'`. */
  platform?: StrybokPlatform;

  /** HTTP transport. Default: the global `fetch`. */
  fetch?: FetchLike;

  /**
   * Publishable client key of the application (`pk_…`, from "Links from the app" in the
   * dashboard). Only needed for `createLink`. It is safe to ship inside the app; never put a
   * secret API key (`lb_…`) here.
   */
  clientKey?: string;

  /**
   * Time allowed for a single attempt to resolve or create a link, in milliseconds. Default 5000.
   */
  timeoutMs?: number;

  /**
   * Extra attempts after a timeout, network error or 5xx. Resolving is an idempotent GET and
   * creating a link returns the existing one for identical content, so retrying is safe. 4xx
   * responses are never retried. Default 2.
   */
  maxRetries?: number;

  /** Pause before the first retry, in milliseconds; doubles for each further retry. Default 400. */
  retryDelayMs?: number;

  /**
   * The identical URL received again within this many milliseconds is treated as a duplicate
   * delivery of the same tap and dropped. Default 2000.
   */
  dedupeWindowMs?: number;

  /** Whether to send a best-effort `app_open` event after a link was resolved. Default `true`. */
  reportAppOpens?: boolean;

  /**
   * Receives errors for links that arrived from the OS but could not be resolved. Links that are
   * simply not ours are ignored without an error.
   */
  onError?: LinkErrorHandler;

  /**
   * Overrides the SDK version sent with `app_open` events. Meant for adapters built on this core
   * (they append their name, e.g. `0.3.0+react-native`); at most 32 characters of `[0-9A-Za-z.+-]`.
   */
  sdkVersion?: string;

  /**
   * Restore a link that was tapped before the app was installed. Default `false`; can also be
   * switched on later with `enableDeferredLinks()`, for example after a consent screen.
   *
   * Android: on the first launch the `installReferrerSources` are asked for the store's install
   * referrer and the click id found in it is exchanged for the link. iOS: only
   * `redeemPastedLink` and, with `allowProbabilisticMatching`, matching. Needs
   * `deferredLinkStore` and `androidPackageName` / `iosBundleId`; without them, and on any other
   * platform, the status stays `'disabled'` and nothing is read, stored or sent.
   */
  deferredLinks?: boolean;

  /**
   * Persistent storage for the state of the check. **Required for deferred links**: this SDK has
   * no storage of its own, and state kept only in memory would run the check again on every
   * launch.
   */
  deferredLinkStore?: DeferredLinkStore;

  /**
   * Android: where the install referrer comes from, in the order to ask. Supplied by the app;
   * this SDK ships no store integration. Empty (the default) ends the check with status
   * `'unavailable'`.
   */
  installReferrerSources?: Iterable<InstallReferrerSource>;

  /** Android: the app's own application ID, e.g. `com.example.app`. Sent with the click id. */
  androidPackageName?: string;

  /** iOS: the app's own bundle identifier. Sent with the click id and with a matching request. */
  iosBundleId?: string;

  /**
   * iOS, **not recommended**: with `deferredLinks`, let the server guess the link from the
   * network address on the first launch. Default `false`.
   *
   * This is fingerprinting in Apple's terms: the App Store Review Guidelines and the Apple
   * Developer Program License Agreement forbid deriving data from a device to identify it, with
   * or without the user's consent; the App Review and legal risk is the app owner's. A match is
   * a guess and on a shared network it can be another person's link — check
   * `ResolvedLink.isProbabilisticMatch`. Needs `deviceFamily` and `locale`.
   */
  allowProbabilisticMatching?: boolean;

  /**
   * iOS probabilistic matching: the device family, `'iphone'`, `'ipad'` or `'ipod'`. Anything
   * else (or no callback) ends the check with status `'unavailable'`.
   */
  deviceFamily?: () => string | null | undefined | Promise<string | null | undefined>;

  /**
   * iOS probabilistic matching: the person's first preferred language as a BCP 47 tag, e.g.
   * `'en-GB'`. No value (or no callback) ends the check with status `'unavailable'`.
   */
  locale?: () => string | null | undefined | Promise<string | null | undefined>;

  /**
   * iOS probabilistic matching, optional: whether the clipboard probably holds a web URL,
   * answered **without reading it** (natively: `UIPasteboard.general.detectPatterns(for:
   * [.probableWebURL])`). When it answers `true` the SDK waits for `redeemPastedLink` or
   * `skipPastedLink` before matching (status `'awaitingPaste'`). Without it that step is skipped.
   */
  pasteboardMayContainLink?: () => boolean | Promise<boolean>;

  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}
