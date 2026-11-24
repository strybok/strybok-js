import {
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
  type StrybokValidationIssue,
} from './errors.js';
import { runtime, sleep, type AbortControllerLike } from './runtime.js';
import type {
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
import { isHostname, parseStrybokLink } from './url.js';
import { uuidV4 } from './uuid.js';
import { SDK_VERSION } from './version.js';

const API_BASE_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i;
const SDK_VERSION_FORMAT = /^[0-9A-Za-z.+-]{1,32}$/;
const PLATFORMS: readonly StrybokPlatform[] = ['ios', 'android', 'unknown'];
const MAX_ROUTE_PATH_LENGTH = 512;
const DISPOSED_MESSAGE = 'Strybok has been disposed';
const DONE: Promise<void> = Promise.resolve();

/** One received URL of ours; remembered for duplicate detection. */
interface Reception {
  readonly url: string;
  at: number;
  /** Whether this is (also) the URL that launched the app. */
  initial: boolean;
  link: ResolvedLink | null;
  /** Settles when the URL has been resolved and delivered, or has failed. Never rejects. */
  done: Promise<void>;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
  /** The `Retry-After` response header, when the transport exposes headers and it was sent. */
  readonly retryAfter: string | null;
}

/**
 * Entry point of the SDK.
 *
 * ```ts
 * const strybok = new Strybok({
 *   apiBaseUrl: 'https://api.strybok.com',
 *   allowedHosts: ['my-app.strybok.link'],
 *   linkSource,
 * });
 * strybok.onLink((link) => router.push(link.routePath));
 * await strybok.initialize();
 * ```
 */
export class Strybok {
  /** Base URL of the Strybok API, without a trailing slash. */
  readonly apiBaseUrl: string;
  /** Link hostnames of this app, lower-cased. */
  readonly allowedHosts: ReadonlySet<string>;
  readonly platform: StrybokPlatform;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly dedupeWindowMs: number;
  readonly reportAppOpens: boolean;
  /** Version sent with `app_open` events. */
  readonly sdkVersion: string;

  /** Only sent with `createLink`. */
  private readonly clientKey: string | undefined;
  private readonly source: LinkSource;
  private readonly customFetch: FetchLike | undefined;
  private readonly onError: LinkErrorHandler | undefined;
  private readonly now: () => number;

  private readonly listeners = new Set<LinkListener>();
  /** Links resolved while nobody was listening (typically the cold-start link). */
  private readonly pending: ResolvedLink[] = [];
  private readonly inFlight = new Set<AbortControllerLike>();
  private unsubscribeSource: Unsubscribe | null = null;
  private initialization: Promise<void> | null = null;
  private initialLink: ResolvedLink | null = null;
  private last: Reception | null = null;
  private disposed = false;

  constructor(options: StrybokOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Strybok: options are required');
    }
    if (typeof options.apiBaseUrl !== 'string' || !API_BASE_URL.test(options.apiBaseUrl)) {
      throw new TypeError(
        'Strybok: apiBaseUrl must be an http(s) URL without query or fragment, ' +
          'e.g. "https://api.strybok.com"',
      );
    }
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');

    const hosts = new Set<string>();
    if (options.allowedHosts === null || options.allowedHosts === undefined) {
      throw new TypeError('Strybok: allowedHosts is required');
    }
    if (typeof options.allowedHosts === 'string') {
      throw new TypeError('Strybok: allowedHosts must be a list of hostnames, not a single string');
    }
    for (const host of options.allowedHosts) {
      if (typeof host !== 'string' || !isHostname(host)) {
        throw new TypeError(
          `Strybok: allowedHosts entries must be bare hostnames like "my-app.strybok.link", ` +
            `got ${JSON.stringify(host)}`,
        );
      }
      hosts.add(host.toLowerCase());
    }
    this.allowedHosts = hosts;

    const source = options.linkSource;
    if (
      source === null ||
      typeof source !== 'object' ||
      typeof source.getInitialUrl !== 'function' ||
      typeof source.subscribe !== 'function'
    ) {
      throw new TypeError('Strybok: linkSource must implement getInitialUrl() and subscribe()');
    }
    this.source = source;

    this.platform = options.platform ?? 'unknown';
    if (!PLATFORMS.includes(this.platform)) {
      throw new TypeError('Strybok: platform must be "ios", "android" or "unknown"');
    }
    this.timeoutMs = duration('timeoutMs', options.timeoutMs, 5000);
    this.retryDelayMs = duration('retryDelayMs', options.retryDelayMs, 400);
    this.dedupeWindowMs = duration('dedupeWindowMs', options.dedupeWindowMs, 2000);
    this.maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError('Strybok: maxRetries must be a non-negative integer');
    }
    this.reportAppOpens = options.reportAppOpens ?? true;
    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    if (typeof this.sdkVersion !== 'string' || !SDK_VERSION_FORMAT.test(this.sdkVersion)) {
      throw new TypeError('Strybok: sdkVersion must be 1-32 characters of [0-9A-Za-z.+-]');
    }

    const clientKey = options.clientKey ?? undefined;
    if (clientKey !== undefined && typeof clientKey !== 'string') {
      throw new TypeError('Strybok: clientKey must be a string');
    }
    this.clientKey = clientKey;

    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
      throw new TypeError('Strybok: fetch must be a function');
    }
    this.customFetch = options.fetch;
    if (this.customFetch === undefined && typeof runtime().fetch !== 'function') {
      throw new TypeError('Strybok: this runtime has no global fetch; pass the `fetch` option');
    }
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts listening for links and handles the one that launched the app.
   *
   * Resolves once the launch link, if any, has been resolved (or has failed), so it is safe to
   * await before the first navigation. Calling it again returns the same promise. Rejects only
   * after {@link dispose}.
   */
  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(DISPOSED_MESSAGE));
    this.initialization ??= this.start();
    return this.initialization;
  }

  /**
   * Registers a listener for resolved links and returns a function that removes it. Every link
   * is delivered exactly once.
   *
   * Links that were resolved while nobody listened (for example the one that cold-started the
   * app) are kept and delivered right after the first listener attaches, asynchronously.
   */
  onLink(listener: LinkListener): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('Strybok: listener must be a function');
    if (this.disposed) return () => {};
    // A wrapper per registration, so the same function can be registered twice independently.
    const entry: LinkListener = (link) => listener(link);
    this.listeners.add(entry);
    if (this.pending.length > 0) this.scheduleDrain();
    return () => {
      this.listeners.delete(entry);
    };
  }

  /**
   * The link that launched the app, if it has not been delivered to an {@link onLink} listener
   * yet. Returns it at most once and removes it from the queue, so using both APIs never
   * navigates twice.
   */
  async getInitialLink(): Promise<ResolvedLink | null> {
    await this.initialize();
    const link = this.initialLink;
    this.initialLink = null;
    if (link === null) return null;
    const index = this.pending.indexOf(link);
    if (index < 0) return null; // A listener already received it.
    this.pending.splice(index, 1);
    return link;
  }

  /**
   * Whether `url` is a Strybok link of this app: `https`, a host from `allowedHosts`, default
   * port, no credentials and a path of exactly one slug. Query and fragment are ignored.
   */
  isStrybokUrl(url: string): boolean {
    return parseStrybokLink(url, this.allowedHosts) !== null;
  }

  /**
   * Resolves `url` through the API without delivering it to listeners and without reporting an
   * app open (for QR scanners, tests and custom flows).
   *
   * Rejects with a {@link StrybokError}: `UnsupportedLinkError` before any network call when the
   * URL is not ours, `LinkNotFoundError` for unknown, disabled or expired links, and
   * network/timeout/server errors otherwise.
   */
  async resolveUrl(url: string): Promise<ResolvedLink> {
    this.checkNotDisposed();
    const parts = parseStrybokLink(url, this.allowedHosts);
    if (parts === null) {
      throw new UnsupportedLinkError(
        'Not a link for this app',
        typeof url === 'string' ? url : undefined,
      );
    }
    // Query and fragment are not needed for the lookup and may hold private data.
    const endpoint = `${this.apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(parts.lookupUrl)}`;

    let lastError: StrybokError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      this.checkNotDisposed();
      let result: HttpResult;
      try {
        result = await this.send(
          endpoint,
          { method: 'GET', headers: { Accept: 'application/json' } },
          true,
        );
      } catch (error) {
        this.checkNotDisposed();
        lastError =
          error === TIMED_OUT
            ? new StrybokTimeoutError(url)
            : new StrybokNetworkError('Network error', url, error);
        continue;
      }
      this.checkNotDisposed();
      if (result.status === 200) return parseResolveResponse(url, result.body);
      if (result.status === 404) throw new LinkNotFoundError(url);
      const error = new StrybokServerError(
        `Unexpected status ${result.status}`,
        result.status,
        url,
      );
      if (!(result.status >= 500)) throw error; // Client errors will not improve.
      lastError = error;
    }
    throw lastError as StrybokError;
  }

  /**
   * Creates a short link to a screen of this app, for a "Share" button, and resolves with it
   * (`url` is what the user shares).
   *
   * Needs the `clientKey` option, and the feature enabled for the application in the dashboard
   * with route patterns that cover `routePath`. Works before and without {@link initialize}, and
   * is never called by the SDK itself. Creating the same link again returns the existing one.
   *
   * Rejects with a {@link StrybokError}, never through `onError`: `StrybokUnauthorizedError`,
   * `RouteNotAllowedError`, `StrybokRateLimitedError`, `StrybokValidationError`, and
   * network/timeout/server errors after the same retries as resolving. The errors never contain
   * the client key or the payload.
   */
  async createLink(routePath: string, options?: CreateLinkOptions): Promise<CreatedLink> {
    this.checkNotDisposed();
    const clientKey = this.clientKey;
    if (clientKey === undefined || clientKey === '') {
      throw new StrybokUnauthorizedError('No clientKey is configured');
    }
    if (
      typeof routePath !== 'string' ||
      !routePath.startsWith('/') ||
      routePath.startsWith('//') ||
      routePath.length > MAX_ROUTE_PATH_LENGTH
    ) {
      throw new StrybokValidationError(
        `routePath must start with a single "/" and be at most ${MAX_ROUTE_PATH_LENGTH} characters long`,
      );
    }
    if (options !== undefined && options !== null && !isRecord(options)) {
      throw new StrybokValidationError('The second argument of createLink must be an object');
    }
    const { payload, title, description, imageUrl } = options ?? {};
    // Built once: every retry sends exactly the same body. Parts that were not given are left
    // out; everything else is the service's to validate.
    const fields: Record<string, unknown> = { routePath };
    if (payload !== undefined && payload !== null) {
      if (!isJsonObject(payload)) {
        throw new StrybokValidationError('payload must be a JSON object');
      }
      fields['payload'] = payload;
    }
    if (title !== undefined && title !== null) fields['title'] = title;
    if (description !== undefined && description !== null) fields['description'] = description;
    if (imageUrl !== undefined && imageUrl !== null) fields['imageUrl'] = imageUrl;
    let body: string;
    try {
      body = JSON.stringify(fields);
    } catch {
      throw new StrybokValidationError('The link cannot be converted to JSON');
    }
    const endpoint = `${this.apiBaseUrl}/v1/public/links`;

    let lastError: StrybokError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      this.checkNotDisposed();
      let result: HttpResult;
      try {
        result = await this.send(
          endpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Strybok-Key': clientKey,
            },
            body,
          },
          true,
        );
      } catch (error) {
        this.checkNotDisposed();
        // Without `cause`: a transport's error may carry the request, key and payload included.
        lastError =
          error === TIMED_OUT
            ? new StrybokTimeoutError(undefined, 'The create link request timed out')
            : new StrybokNetworkError('Network error');
        continue;
      }
      this.checkNotDisposed();
      const { status } = result;
      if (status === 200 || status === 201) return parseCreateLinkResponse(status, result.body);
      if (status === 401) {
        throw new StrybokUnauthorizedError(
          'The client key was not accepted, or creating links from the app is switched off',
        );
      }
      if (status === 403) throw new RouteNotAllowedError(routePath);
      if (status === 429) {
        throw new StrybokRateLimitedError(parseRetryAfter(result.retryAfter, this.now()));
      }
      if (status === 400 || status === 413 || status === 422) {
        throw parseValidationResponse(status, result.body);
      }
      const error = new StrybokServerError(`Unexpected status ${status}`, status);
      if (!(status >= 500)) throw error; // Client errors will not improve.
      lastError = error;
    }
    throw lastError as StrybokError;
  }

  /**
   * Stops listening, cancels requests in flight and drops queued links. Nothing is delivered
   * afterwards. The instance cannot be reused. Safe to call more than once.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = 0;
    this.initialLink = null;
    this.last = null;
    this.listeners.clear();
    const unsubscribe = this.unsubscribeSource;
    this.unsubscribeSource = null;
    try {
      unsubscribe?.();
    } catch {
      // A misbehaving source must not make dispose fail.
    }
    for (const controller of [...this.inFlight]) abortQuietly(controller);
    this.inFlight.clear();
  }

  // -----------------------------------------------------------------------------------------

  private async start(): Promise<void> {
    // Listen first so a link arriving during start-up is not missed.
    const unsubscribe = this.source.subscribe((url) => {
      void this.handle(url, false);
    });
    this.unsubscribeSource = typeof unsubscribe === 'function' ? unsubscribe : null;

    let initial: unknown = null;
    try {
      initial = await this.source.getInitialUrl();
    } catch {
      // The platform could not tell us; treat as "no launch link".
    }
    await this.handle(initial, true);
  }

  /** Never rejects. */
  private handle(url: unknown, isInitial: boolean): Promise<void> {
    if (this.disposed || typeof url !== 'string' || !this.isStrybokUrl(url)) return DONE;

    // The OS (or the host framework) can hand over the same tap twice, e.g. as the launch URL
    // and again through the subscription.
    const now = this.now();
    const last = this.last;
    if (last !== null && last.url === url && now - last.at < this.dedupeWindowMs) {
      last.at = now;
      if (!isInitial) return DONE;
      // The launch URL was reported by the subscription first: that reception is the launch link.
      last.initial = true;
      if (last.link !== null) this.initialLink = last.link;
      return last.done;
    }

    const reception: Reception = { url, at: now, initial: isInitial, link: null, done: DONE };
    this.last = reception;
    reception.done = this.process(reception);
    return reception.done;
  }

  private async process(reception: Reception): Promise<void> {
    let link: ResolvedLink;
    try {
      link = await this.resolveUrl(reception.url);
    } catch (error) {
      // Disposed mid-flight: nothing to report.
      if (!this.disposed && error instanceof StrybokError) this.reportError(error);
      return;
    }
    if (this.disposed) return;
    reception.link = link;
    if (reception.initial) this.initialLink = link;
    if (this.listeners.size > 0 && this.pending.length === 0) {
      this.emit(link);
    } else {
      this.pending.push(link); // Behind anything still queued, to keep the order.
      this.scheduleDrain();
    }
    if (this.reportAppOpens) void this.reportAppOpen(link);
  }

  /**
   * Hands queued links to the listeners on a later microtask: the caller of `onLink` first gets
   * its unsubscribe function. Links stay queued until then, so a listener that is removed again
   * right away (React StrictMode mounts effects twice) cannot swallow them.
   */
  private scheduleDrain(): void {
    void Promise.resolve().then(() => {
      if (this.disposed || this.listeners.size === 0) return;
      for (const link of this.pending.splice(0)) this.emit(link);
    });
  }

  private emit(link: ResolvedLink): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue; // Removed by an earlier listener.
      try {
        listener(link);
      } catch (error) {
        rethrowLater(error);
      }
    }
  }

  private reportError(error: StrybokError): void {
    if (this.onError === undefined) return;
    try {
      this.onError(error);
    } catch (thrown) {
      rethrowLater(thrown);
    }
  }

  /**
   * One HTTP exchange, limited to `timeoutMs` as a whole (headers and body). Rejects with
   * {@link TIMED_OUT} on timeout and with whatever the transport threw otherwise.
   */
  private send(url: string, init: FetchRequestInit, readBody: boolean): Promise<HttpResult> {
    const { setTimeout, clearTimeout, AbortController, fetch: globalFetch } = runtime();
    const doFetch = this.customFetch ?? globalFetch;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller !== null) this.inFlight.add(controller);

    return new Promise<HttpResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Reject first: aborting makes the transport reject too, and the timeout must win.
        reject(TIMED_OUT);
        if (controller !== null) abortQuietly(controller);
      }, this.timeoutMs);

      const exchange = async (): Promise<HttpResult> => {
        if (doFetch === undefined) throw new TypeError('No fetch implementation available');
        const response = await doFetch(
          url,
          controller !== null ? { ...init, signal: controller.signal } : init,
        );
        return {
          status: response.status,
          retryAfter: readHeader(response, 'Retry-After'),
          body: readBody ? await response.text() : '',
        };
      };
      exchange()
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          if (controller !== null) this.inFlight.delete(controller);
        });
    });
  }

  /**
   * Best effort and never awaited by navigation. This is a self-reported metric (an app can be
   * modified), separate from server-side fallback visits.
   */
  private async reportAppOpen(link: ResolvedLink): Promise<void> {
    try {
      await this.send(
        `${this.apiBaseUrl}/v1/public/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId: uuidV4(),
            linkId: link.linkId,
            type: 'app_open',
            platform: this.platform,
            sdkVersion: this.sdkVersion,
          }),
        },
        false,
      );
    } catch {
      // Analytics must never affect the app.
    }
  }

  private checkNotDisposed(): void {
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
  }
}

/** Sentinel rejection of {@link Strybok.send}. */
const TIMED_OUT = { timedOut: true } as const;

function parseResolveResponse(url: string, body: string): ResolvedLink {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  if (isRecord(json)) {
    const { linkId, appId, routePath, payload } = json;
    if (
      typeof linkId === 'string' &&
      typeof appId === 'string' &&
      typeof routePath === 'string' &&
      routePath.startsWith('/') &&
      !routePath.startsWith('//')
    ) {
      return { url, linkId, appId, routePath, payload: isRecord(payload) ? payload : {} };
    }
  }
  throw new StrybokServerError('Malformed resolve response', 200, url);
}

function parseCreateLinkResponse(status: number, body: string): CreatedLink {
  const json = parseJson(body);
  if (isRecord(json)) {
    const { linkId, slug, routePath, url } = json;
    if (
      typeof linkId === 'string' &&
      typeof slug === 'string' &&
      typeof routePath === 'string' &&
      typeof url === 'string' &&
      /^https:\/\//i.test(url)
    ) {
      return { url, slug, routePath, linkId };
    }
  }
  throw new StrybokServerError('Malformed create link response', status);
}

/** Reads `error.message` and `error.details.issues` of a 400, 413 or 422 answer, if present. */
function parseValidationResponse(status: number, body: string): StrybokValidationError {
  const json = parseJson(body);
  const error = isRecord(json) && isRecord(json['error']) ? json['error'] : {};
  const message = error['message'];
  const details = error['details'];
  const rawIssues: unknown = isRecord(details) ? details['issues'] : undefined;
  const issues: StrybokValidationIssue[] = [];
  if (Array.isArray(rawIssues)) {
    for (const issue of rawIssues as unknown[]) {
      if (
        isRecord(issue) &&
        typeof issue['path'] === 'string' &&
        typeof issue['message'] === 'string'
      ) {
        issues.push({ path: issue['path'], message: issue['message'] });
      }
    }
  }
  return new StrybokValidationError(
    typeof message === 'string' && message !== ''
      ? message
      : `The service rejected the link (status ${status})`,
    status,
    issues,
  );
}

/** `Retry-After` in seconds: the header is a number of seconds or an HTTP date. */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (!/[A-Za-z]/.test(value)) return undefined; // Not a date either; `Date.parse` is lenient.
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

/** Transports are not required to provide headers, and a broken one must not fail the request. */
function readHeader(response: FetchResponseLike, name: string): string | null {
  try {
    const value = response.headers?.get(name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whether `value` is sent as a JSON object: an object whose JSON form is one, too. */
function isJsonObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    // A Date or anything else with `toJSON` is an object here and a scalar on the wire.
    return JSON.stringify(value).startsWith('{');
  } catch {
    return false; // Circular, or holds a BigInt.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duration(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`Strybok: ${name} must be a non-negative number of milliseconds`);
  }
  return value;
}

function abortQuietly(controller: AbortControllerLike): void {
  try {
    controller.abort();
  } catch {
    // Nothing useful to do.
  }
}

/** An exception in app code must surface, but not break delivery to other listeners. */
function rethrowLater(error: unknown): void {
  runtime().setTimeout(() => {
    throw error;
  }, 0);
}
