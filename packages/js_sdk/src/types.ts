import type { StrybokError } from './errors.js';

/** Platform reported with `app_open` events. */
export type StrybokPlatform = 'ios' | 'android' | 'unknown';

/**
 * A link resolved by the Strybok API.
 *
 * `routePath` and `payload` are plain data chosen by whoever created the link. Treat them like
 * any other untrusted input: map them onto routes your app already knows, never execute them.
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
   * (they append their name, e.g. `0.2.0+react-native`); at most 32 characters of `[0-9A-Za-z.+-]`.
   */
  sdkVersion?: string;

  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}
