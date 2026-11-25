import { parseJson, parseLinkFields, isRecord } from './link-response.js';
import { runtime, sleep } from './runtime.js';
import type {
  DeferredLinkStatus,
  DeferredLinkStatusListener,
  DeferredLinkStore,
  FetchRequestInit,
  InstallReferrerAnswer,
  InstallReferrerSource,
  PastedLinkResult,
  ResolvedLink,
  StrybokOptions,
  StrybokPlatform,
  Unsubscribe,
} from './types.js';
import { firstQueryValue, parseStrybokLink, parseUrl } from './url.js';

/** One HTTP answer, as the transport of the SDK returns it. */
export interface HttpResult {
  readonly status: number;
  readonly body: string;
  /** The `Retry-After` response header, when the transport exposes headers and it was sent. */
  readonly retryAfter: string | null;
}

/** What the deferred-link check needs from the SDK instance it belongs to. */
export interface DeferredHost {
  readonly apiBaseUrl: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly platform: StrybokPlatform;
  readonly sdkVersion: string;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  /** One exchange within the SDK's timeout; rejects on a timeout or a transport failure. */
  send(url: string, init: FetchRequestInit): Promise<HttpResult>;
  isDisposed(): boolean;
  /** Whether a link of this app arrived from the link source since the process started. */
  normalLinkAccepted(): boolean;
  /** Hands a link to the exactly-once pipeline: not the launch link, no `app_open`. */
  deliver(link: ResolvedLink): void;
}

export type DeferredOptions = Pick<
  StrybokOptions,
  | 'deferredLinks'
  | 'deferredLinkStore'
  | 'installReferrerSources'
  | 'androidPackageName'
  | 'iosBundleId'
  | 'allowProbabilisticMatching'
  | 'deviceFamily'
  | 'locale'
  | 'pasteboardMayContainLink'
>;

/** Keys of the only two values the check ever stores. */
export const ATTEMPTS_KEY = 'strybok.deferred.attempts';
export const DONE_KEY = 'strybok.deferred.done';

const MAX_ATTEMPTS = 3;
/** A source that has not answered by then counts as "unavailable for now". */
const SOURCE_TIMEOUT_MS = 10_000;
const REFERRER_KEY = 'strybok_click';
const CLICK_ID = /^dc_[0-9A-Za-z]{32}$/;
const ENCODED_REFERRER_KEY = /strybok_click%3d/i;
const DEVICE_FAMILIES: readonly string[] = ['iphone', 'ipad', 'ipod'];
/** What the match endpoint accepts as `locale`. */
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,4}$/;
const REDEEM_PATH = '/v1/public/deferred-links/redeem';
const MATCH_PATH = '/v1/public/deferred-links/match';

const LATER: InstallReferrerAnswer = { status: 'unavailableForNow' };

/** How a redeem or match request ended. */
type Outcome =
  /** A usable 200. */
  | { readonly kind: 'link'; readonly link: ResolvedLink }
  /** A 200 that is not a link of this app, or a status the contract does not know. */
  | { readonly kind: 'unusable' }
  /** 404 or another 4xx except 429. */
  | { readonly kind: 'notFound' }
  /** 429, or 5xx / transport failure / timeout after the retries. */
  | { readonly kind: 'transient' }
  /** The SDK was disposed before an answer arrived. */
  | { readonly kind: 'disposed' };

interface StoredState {
  readonly attempts: number;
  readonly done: boolean;
}

/**
 * Deferred links (the contract's "Deferred links (optional, Android)" and "Deferred links on
 * iOS (optional)"), for a runtime without native code: the install referrer, the pasted text,
 * the device family, the language and the storage all come from the app.
 *
 * The referrer, the pasted text and the click id are never stored, logged or put into an error.
 * Nothing here throws or reports to `onError`; the only output besides the delivered link is
 * {@link status}.
 */
export class DeferredLinks {
  status: DeferredLinkStatus;

  private readonly store: DeferredLinkStore | undefined;
  private readonly sources: readonly InstallReferrerSource[];
  private readonly androidPackageName: string | undefined;
  private readonly iosBundleId: string | undefined;
  private readonly allowProbabilisticMatching: boolean;
  private readonly deviceFamily: DeferredOptions['deviceFamily'];
  private readonly locale: DeferredOptions['locale'];
  private readonly pasteboardMayContainLink: DeferredOptions['pasteboardMayContainLink'];

  private readonly listeners = new Set<DeferredLinkStatusListener>();
  private enabled: boolean;
  /** `initialize` has completed everything else. */
  private hostStarted = false;
  /** The automatic check has begun in this process; it never begins twice. */
  private ran = false;
  /**
   * In-memory mirror of the stored `done`, set at the moment a flow decides to store it, so that
   * the two iOS flows can never both deliver.
   */
  private done = false;
  private awaitingPaste = false;
  /** Serializes `redeemPastedLink` calls. Never rejects. */
  private pasteQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: DeferredHost,
    options: DeferredOptions,
  ) {
    this.enabled = flag('deferredLinks', options.deferredLinks);
    this.allowProbabilisticMatching = flag(
      'allowProbabilisticMatching',
      options.allowProbabilisticMatching,
    );

    const store = options.deferredLinkStore ?? undefined;
    if (
      store !== undefined &&
      (typeof store !== 'object' ||
        typeof store.getItem !== 'function' ||
        typeof store.setItem !== 'function')
    ) {
      throw new TypeError('Strybok: deferredLinkStore must implement getItem() and setItem()');
    }
    this.store = store;

    const sources: InstallReferrerSource[] = [];
    const given = options.installReferrerSources ?? [];
    if (typeof given === 'function' || typeof given === 'string') {
      throw new TypeError('Strybok: installReferrerSources must be a list of functions');
    }
    for (const source of given) {
      if (typeof source !== 'function') {
        throw new TypeError('Strybok: installReferrerSources must be a list of functions');
      }
      sources.push(source);
    }
    this.sources = sources;

    this.androidPackageName = text('androidPackageName', options.androidPackageName);
    this.iosBundleId = text('iosBundleId', options.iosBundleId);
    this.deviceFamily = callback('deviceFamily', options.deviceFamily);
    this.locale = callback('locale', options.locale);
    this.pasteboardMayContainLink = callback(
      'pasteboardMayContainLink',
      options.pasteboardMayContainLink,
    );

    this.status = this.effective ? 'pending' : 'disabled';
  }

  /**
   * Whether anything of this feature may happen at all: switched on, on Android or iOS, with
   * somewhere to keep the state and the identifier the server binds the request to.
   */
  private get effective(): boolean {
    if (!this.enabled || this.store === undefined) return false;
    if (this.host.platform === 'android') return isFilled(this.androidPackageName);
    if (this.host.platform === 'ios') return isFilled(this.iosBundleId);
    return false;
  }

  subscribe(listener: DeferredLinkStatusListener): Unsubscribe {
    const entry: DeferredLinkStatusListener = (status) => listener(status);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Switches the feature on (after a consent screen, say) and runs the check if it is due. */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    if (!this.effective) return;
    this.setStatus('pending');
    this.runIfDue();
  }

  /** Called once `initialize` has completed everything it does without this feature. */
  started(): void {
    this.hostStarted = true;
    this.runIfDue();
  }

  dispose(): void {
    this.listeners.clear();
    this.awaitingPaste = false;
  }

  redeemPastedLink(pasted: unknown): Promise<PastedLinkResult> {
    const run = this.pasteQueue.then(() => this.redeemPasted(pasted));
    const safe = run.catch((): PastedLinkResult => 'failed');
    this.pasteQueue = safe;
    return safe;
  }

  skipPastedLink(): void {
    this.resumeMatching();
  }

  // -----------------------------------------------------------------------------------------

  private runIfDue(): void {
    if (!this.hostStarted || this.ran || !this.effective || this.host.isDisposed()) return;
    this.ran = true;
    // A pasted link was handled before the start: that was this launch's answer.
    if (this.done) return;
    this.setStatus('checking');
    const check = this.host.platform === 'android' ? this.checkAndroid() : this.checkIos();
    // Storage and callbacks are the app's; whatever they do, this must stay silent.
    check.catch(() => this.unfinished());
  }

  /** Something of the app's (storage, a callback) threw where nothing should: try next launch. */
  private unfinished(): void {
    if (!this.done) this.setStatus('pending');
  }

  /** The contract's Android flow, steps 2 to 7. */
  private async checkAndroid(): Promise<void> {
    const state = await this.readState();
    if (this.host.isDisposed()) return;
    if (state === null) return this.setStatus('pending');
    if (state.done) {
      this.done = true;
      return this.setStatus('notFirstLaunch');
    }
    if (state.attempts >= MAX_ATTEMPTS) {
      await this.storeDone();
      return this.setStatus('failed');
    }
    // Before anything else happens: a launch that dies from here on has used up an attempt.
    if (!(await this.storeAttempts(state.attempts + 1))) return this.setStatus('pending');

    let clickId: string | null = null;
    let sawReferrer = false;
    let sawLater = false;
    for (const source of this.sources) {
      if (this.host.isDisposed()) return;
      const answer = await ask(source);
      if (answer.status === 'referrer') {
        sawReferrer = true;
        clickId = findClickId(answer.referrer);
        if (clickId !== null) break;
      } else if (answer.status === 'unavailableForNow') {
        sawLater = true;
      }
    }
    if (this.host.isDisposed()) return;
    if (clickId === null) {
      if (sawLater) return this.setStatus('pending');
      await this.storeDone();
      return this.setStatus(sawReferrer ? 'noReferrer' : 'unavailable');
    }

    if (this.host.normalLinkAccepted()) {
      await this.storeDone();
      return this.setStatus('superseded');
    }
    const outcome = await this.exchange(
      REDEEM_PATH,
      JSON.stringify({
        platform: 'android',
        clickId,
        packageName: this.androidPackageName,
        sdkVersion: this.host.sdkVersion,
      }),
      false,
    );
    await this.finishCheck(outcome);
  }

  /** The start of the contract's iOS flow B; flow A is {@link redeemPasted}. */
  private async checkIos(): Promise<void> {
    const state = await this.readState();
    if (this.host.isDisposed()) return;
    if (state === null) return this.setStatus('pending');
    if (state.done) {
      this.done = true;
      return this.setStatus('notFirstLaunch');
    }
    // Only a pasted link can restore anything; nothing automatic exists, and nothing is stored.
    if (!this.allowProbabilisticMatching) return this.setStatus('unavailable');

    // Clipboard first: when there may be a link to paste, do not guess yet.
    const probe = this.pasteboardMayContainLink;
    if (probe !== undefined) {
      let mayContain = false;
      try {
        mayContain = (await probe()) === true;
      } catch {
        // No answer is "nothing to paste".
      }
      if (this.host.isDisposed() || this.done) return;
      if (mayContain) {
        this.awaitingPaste = true;
        return this.setStatus('awaitingPaste');
      }
    }
    await this.match();
  }

  /** Continues flow B after the paste step: `notOurs` was pasted, or the person moved on. */
  private resumeMatching(): void {
    if (!this.awaitingPaste || this.done || this.host.isDisposed()) return;
    this.awaitingPaste = false;
    this.setStatus('checking');
    this.match().catch(() => this.unfinished());
  }

  /** Flow B, steps 3 to 6. */
  private async match(): Promise<void> {
    const state = await this.readState();
    if (this.host.isDisposed() || this.done) return;
    if (state === null) return this.setStatus('pending');
    if (state.done) {
      this.done = true;
      return this.setStatus('notFirstLaunch');
    }
    if (state.attempts >= MAX_ATTEMPTS) {
      await this.storeDone();
      return this.setStatus('failed');
    }
    const counted = await this.storeAttempts(state.attempts + 1);
    if (this.done) return; // A pasted link was handled while the attempt was being stored.
    if (!counted) return this.setStatus('pending');
    if (this.host.normalLinkAccepted()) {
      await this.storeDone();
      return this.setStatus('superseded');
    }

    const deviceFamily = await answerOf(this.deviceFamily);
    const locale = await answerOf(this.locale);
    if (this.host.isDisposed() || this.done) return;
    if (
      typeof deviceFamily !== 'string' ||
      !DEVICE_FAMILIES.includes(deviceFamily) ||
      typeof locale !== 'string' ||
      !LOCALE.test(locale)
    ) {
      await this.storeDone();
      return this.setStatus('unavailable');
    }
    const outcome = await this.exchange(
      MATCH_PATH,
      JSON.stringify({
        platform: 'ios',
        bundleId: this.iosBundleId,
        deviceFamily,
        locale,
        sdkVersion: this.host.sdkVersion,
      }),
      true,
    );
    await this.finishCheck(outcome);
  }

  /** The outcome tables of the automatic flows (Android, and iOS flow B). */
  private async finishCheck(outcome: Outcome): Promise<void> {
    if (outcome.kind === 'disposed') return;
    // A pasted link was handled while this request was in flight: that flow has the last word.
    if (this.done) return;
    if (outcome.kind === 'transient') return this.setStatus('pending');
    if (outcome.kind === 'notFound') {
      await this.storeDone();
      return this.setStatus('notFound');
    }
    if (outcome.kind === 'unusable') {
      await this.storeDone();
      return this.setStatus('failed');
    }
    // A normal link wins, at any moment before the deferred one is handed over.
    if (this.host.normalLinkAccepted()) {
      await this.storeDone();
      return this.setStatus('superseded');
    }
    // `done` first: a crash after the app received the link must not deliver it again.
    if (!(await this.storeDone())) return this.setStatus('failed');
    if (this.host.isDisposed()) return;
    if (this.host.normalLinkAccepted()) return this.setStatus('superseded');
    this.host.deliver(outcome.link);
    this.setStatus('delivered');
  }

  /** The contract's iOS flow A. */
  private async redeemPasted(pasted: unknown): Promise<PastedLinkResult> {
    if (!this.effective || this.host.platform !== 'ios' || this.host.isDisposed()) {
      return 'disabled';
    }
    if (this.done) return 'alreadyHandled';
    const state = await this.readState();
    if (this.host.isDisposed()) return 'disabled';
    if (state === null) return 'failed';
    if (state.done || this.done) {
      this.done = true;
      return 'alreadyHandled';
    }

    const clickId = pastedClickId(pasted, this.host.allowedHosts);
    if (clickId === null) {
      // Anything may have been on the clipboard; it goes nowhere. Matching may now run.
      this.resumeMatching();
      return 'notOurs';
    }
    // Only the id is sent, never the pasted URL.
    const outcome = await this.exchange(
      REDEEM_PATH,
      JSON.stringify({
        platform: 'ios',
        clickId,
        bundleId: this.iosBundleId,
        sdkVersion: this.host.sdkVersion,
      }),
      false,
    );
    if (outcome.kind === 'disposed' || outcome.kind === 'transient') return 'failed';
    if (this.done) return 'alreadyHandled'; // Matching delivered while this was in flight.
    this.awaitingPaste = false;
    if (outcome.kind === 'notFound') {
      await this.storeDone();
      this.setStatus('notFound');
      return 'notFound';
    }
    if (outcome.kind === 'unusable') {
      await this.storeDone();
      this.setStatus('failed');
      return 'failed';
    }
    // Delivered even after a normal link: pasting was the person's own, explicit action.
    if (!(await this.storeDone())) {
      this.setStatus('failed');
      return 'failed';
    }
    if (this.host.isDisposed()) return 'failed';
    this.host.deliver(outcome.link);
    this.setStatus('delivered');
    return 'delivered';
  }

  /**
   * One POST with the same timeout and retries as resolving; every retry sends the identical
   * body. 429 is not retried in this launch.
   */
  private async exchange(path: string, body: string, probabilistic: boolean): Promise<Outcome> {
    const { host } = this;
    for (let attempt = 0; attempt <= host.maxRetries; attempt++) {
      if (attempt > 0) await sleep(host.retryDelayMs * 2 ** (attempt - 1));
      if (host.isDisposed()) return { kind: 'disposed' };
      let result: HttpResult;
      try {
        result = await host.send(`${host.apiBaseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
        });
      } catch {
        // A timeout or a transport failure; the error may hold the request and is dropped.
        if (host.isDisposed()) return { kind: 'disposed' };
        continue;
      }
      const { status } = result;
      if (status === 200) {
        const link = parseDeferredAnswer(result.body, host.allowedHosts, probabilistic);
        return link === null ? { kind: 'unusable' } : { kind: 'link', link };
      }
      if (status === 429) return { kind: 'transient' };
      if (status >= 500) continue;
      return status >= 400 ? { kind: 'notFound' } : { kind: 'unusable' };
    }
    return { kind: 'transient' };
  }

  /** `null` when the storage could not be read: then nothing is known and nothing is done. */
  private async readState(): Promise<StoredState | null> {
    const store = this.store;
    if (store === undefined) return null;
    try {
      const done = await store.getItem(DONE_KEY);
      const attempts = await store.getItem(ATTEMPTS_KEY);
      // A value that is not a count (never written by this code) ends the check: it must not
      // be able to make it run more than three times.
      const count =
        attempts === null || attempts === undefined
          ? 0
          : typeof attempts === 'string' && /^\d{1,9}$/.test(attempts)
            ? Number(attempts)
            : MAX_ATTEMPTS;
      return { attempts: count, done: typeof done === 'string' && done !== '' };
    } catch {
      return null;
    }
  }

  private async storeAttempts(attempts: number): Promise<boolean> {
    try {
      await this.store?.setItem(ATTEMPTS_KEY, String(attempts));
      return true;
    } catch {
      return false;
    }
  }

  /** Marks the check as finished for this installation; `false` when it could not be stored. */
  private async storeDone(): Promise<boolean> {
    this.done = true;
    this.awaitingPaste = false;
    try {
      await this.store?.setItem(DONE_KEY, '1');
      return true;
    } catch {
      return false;
    }
  }

  private setStatus(status: DeferredLinkStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener(status);
      } catch (error) {
        runtime().setTimeout(() => {
          throw error;
        }, 0);
      }
    }
  }
}

/**
 * The contract's "Finding the click id in a referrer". Everything else in the string is ignored:
 * not parsed further, not stored, not sent, not logged.
 */
export function findClickId(referrer: string): string | null {
  const direct = scanReferrer(referrer);
  if (direct !== undefined) return direct;
  // A store may return the value still encoded: decode the whole string once and try again.
  if (!ENCODED_REFERRER_KEY.test(referrer)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(referrer);
  } catch {
    return null;
  }
  return scanReferrer(decoded) ?? null;
}

/** The id of the first part whose key is ours, `null` when its value is not one, else `undefined`. */
function scanReferrer(referrer: string): string | null | undefined {
  for (const part of referrer.split('&')) {
    const equals = part.indexOf('=');
    if ((equals >= 0 ? part.slice(0, equals) : part) !== REFERRER_KEY) continue;
    const value = equals >= 0 ? part.slice(equals + 1) : '';
    return CLICK_ID.test(value) ? value : null;
  }
  return undefined;
}

/**
 * The click id of a pasted text, when the text is a link of this app that carries one
 * (flow A, step 2). `null` for everything else.
 */
export function pastedClickId(pasted: unknown, allowedHosts: ReadonlySet<string>): string | null {
  if (typeof pasted !== 'string') return null;
  const candidate = pasted.trim();
  if (parseStrybokLink(candidate, allowedHosts) === null) return null;
  const clickId = firstQueryValue(parseUrl(candidate)?.query ?? null, REFERRER_KEY);
  return clickId !== null && CLICK_ID.test(clickId) ? clickId : null;
}

/** A 200 answer of redeem or match as a deferred link, or `null` when it is not usable. */
function parseDeferredAnswer(
  body: string,
  allowedHosts: ReadonlySet<string>,
  probabilistic: boolean,
): ResolvedLink | null {
  const json = parseJson(body);
  const fields = parseLinkFields(json);
  if (fields === null || !isRecord(json)) return null;
  const { url, deferred, matched } = json;
  if (deferred !== true) return null;
  if (probabilistic && matched !== 'probabilistic') return null;
  // The server says which link it was; a link of another app is never delivered.
  if (typeof url !== 'string' || parseStrybokLink(url, allowedHosts) === null) return null;
  return { url, ...fields, isDeferred: true, isProbabilisticMatch: probabilistic };
}

/** Asks one source, without ever throwing and without waiting longer than the limit. */
function ask(source: InstallReferrerSource): Promise<InstallReferrerAnswer> {
  const { setTimeout, clearTimeout } = runtime();
  return new Promise((resolve) => {
    // The call is abandoned, not cancelled: a source has no way to be told.
    const timer = setTimeout(() => resolve(LATER), SOURCE_TIMEOUT_MS);
    const settle = (answer: InstallReferrerAnswer): void => {
      clearTimeout(timer);
      resolve(answer);
    };
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(source());
    } catch {
      settle(LATER);
      return;
    }
    answer.then(
      (value) => settle(toAnswer(value)),
      () => settle(LATER),
    );
  });
}

function toAnswer(value: unknown): InstallReferrerAnswer {
  if (!isRecord(value)) return LATER;
  if (value['status'] === 'referrer') {
    const referrer = value['referrer'];
    return typeof referrer === 'string' ? { status: 'referrer', referrer } : LATER;
  }
  return value['status'] === 'unavailable' ? { status: 'unavailable' } : LATER;
}

/** The answer of an optional app callback; `undefined` when there is none or it failed. */
async function answerOf(provider: (() => unknown) | undefined): Promise<unknown> {
  if (provider === undefined) return undefined;
  try {
    return await provider();
  } catch {
    return undefined;
  }
}

function isFilled(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function flag(name: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new TypeError(`Strybok: ${name} must be a boolean`);
  return value;
}

function text(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError(`Strybok: ${name} must be a string`);
  return value;
}

function callback<T>(name: string, value: T | null | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'function') throw new TypeError(`Strybok: ${name} must be a function`);
  return value;
}
