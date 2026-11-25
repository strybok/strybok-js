// Deferred links: the contract's "Deferred links (optional, Android)" and "Deferred links on iOS
// (optional)", for an SDK without native code. Fake sources, a fake store and a stub transport.
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  SDK_VERSION,
  Strybok,
  type DeferredLinkStatus,
  type DeferredLinkStore,
  type FetchRequestInit,
  type FetchResponseLike,
  type InstallReferrerAnswer,
  type InstallReferrerSource,
  type ResolvedLink,
  type StrybokError,
  type StrybokOptions,
} from '../src/index.js';
import { ATTEMPTS_KEY, DONE_KEY, findClickId, pastedClickId } from '../src/deferred.js';
import { FakeLinkSource } from '../src/testing.js';
import { apiBaseUrl, host, invite, never, response, settle } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

const clickId = `dc_${'aB3x'.repeat(8)}`;
const otherClickId = `dc_${'Zz90'.repeat(8)}`;
const redeemUrl = `${apiBaseUrl}/v1/public/deferred-links/redeem`;
const matchUrl = `${apiBaseUrl}/v1/public/deferred-links/match`;
const packageName = 'com.example.app';
const bundleId = 'com.example.App';
const pasted = `${invite}?strybok_click=${clickId}`;

type Answer = FetchResponseLike | Promise<FetchResponseLike>;

function deferredBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    linkId: 'link_d',
    appId: 'app_1',
    routePath: '/invite/abc123',
    payload: { invitationId: 'abc123' },
    campaign: { source: 'instagram', other: 'ignored' },
    url: invite,
    deferred: true,
    ...extra,
  });
}

const redeemed = (extra?: Record<string, unknown>): FetchResponseLike =>
  response(200, deferredBody(extra));
const matched = (extra?: Record<string, unknown>): FetchResponseLike =>
  response(200, deferredBody({ matched: 'probabilistic', ...extra }));

interface Recorded {
  readonly url: string;
  readonly init: FetchRequestInit;
}

/** Records every request by endpoint. */
class Server {
  readonly redeems: Recorded[] = [];
  readonly matches: Recorded[] = [];
  readonly resolves: Recorded[] = [];
  readonly events: Recorded[] = [];
  onRedeem: (request: Recorded) => Answer = () => redeemed();
  onMatch: (request: Recorded) => Answer = () => matched();
  onResolve: (request: Recorded) => Answer = () =>
    response(200, JSON.stringify({ linkId: 'link_n', appId: 'app_1', routePath: '/normal' }));

  get total(): number {
    return this.redeems.length + this.matches.length + this.resolves.length + this.events.length;
  }

  readonly fetch = async (url: string, init: FetchRequestInit): Promise<FetchResponseLike> => {
    const request = { url, init };
    if (url === redeemUrl) {
      this.redeems.push(request);
      return this.onRedeem(request);
    }
    if (url === matchUrl) {
      this.matches.push(request);
      return this.onMatch(request);
    }
    if (url.endsWith('/v1/public/events')) {
      this.events.push(request);
      return response(202);
    }
    this.resolves.push(request);
    return this.onResolve(request);
  };
}

/** Survives a "restart": the next instance gets the same object, like storage on a device. */
class MemoryStore implements DeferredLinkStore {
  readonly data = new Map<string, string>();
  readonly writes: string[] = [];
  reads = 0;
  failReads = false;
  failWritesTo: string | null = null;

  getItem(key: string): Promise<string | null> {
    this.reads++;
    if (this.failReads) return Promise.reject(new Error('storage is broken'));
    return Promise.resolve(this.data.get(key) ?? null);
  }

  setItem(key: string, value: string): Promise<void> {
    if (this.failWritesTo === key) return Promise.reject(new Error('storage is full'));
    this.writes.push(`${key}=${value}`);
    this.data.set(key, value);
    return Promise.resolve();
  }

  get attempts(): string | undefined {
    return this.data.get(ATTEMPTS_KEY);
  }

  get done(): boolean {
    return this.data.has(DONE_KEY);
  }
}

const referrer = (value: string): InstallReferrerAnswer => ({
  status: 'referrer',
  referrer: value,
});
const forNow: InstallReferrerAnswer = { status: 'unavailableForNow' };
const forGood: InstallReferrerAnswer = { status: 'unavailable' };
const ours = referrer(`strybok_click=${clickId}`);

interface Launch {
  readonly sdk: Strybok;
  readonly server: Server;
  readonly store: MemoryStore;
  readonly source: FakeLinkSource;
  readonly links: ResolvedLink[];
  readonly errors: StrybokError[];
  readonly statuses: DeferredLinkStatus[];
}

type LaunchOptions = Partial<StrybokOptions> & {
  server?: Server;
  store?: MemoryStore;
  source?: FakeLinkSource;
  /** Attach an `onLink` listener before starting. Default `true`. */
  listen?: boolean;
};

/** One process: a new SDK instance, started unless `start` is `false`. */
function launch(defaults: Partial<StrybokOptions>, options: LaunchOptions = {}): Launch {
  const { server = new Server(), store = new MemoryStore(), listen = true, ...rest } = options;
  const source = options.source ?? new FakeLinkSource();
  const links: ResolvedLink[] = [];
  const errors: StrybokError[] = [];
  const statuses: DeferredLinkStatus[] = [];
  const sdk = new Strybok({
    apiBaseUrl,
    allowedHosts: [host],
    linkSource: source,
    fetch: server.fetch,
    timeoutMs: 60,
    retryDelayMs: 1,
    onError: (error) => errors.push(error),
    deferredLinks: true,
    deferredLinkStore: store,
    ...defaults,
    ...rest,
  });
  onTestFinished(() => sdk.dispose());
  sdk.onDeferredLinkStatus((status) => statuses.push(status));
  if (listen) sdk.onLink((link) => links.push(link));
  return { sdk, server, store, source, links, errors, statuses };
}

const android = (options: LaunchOptions = {}): Launch =>
  launch(
    {
      platform: 'android',
      androidPackageName: packageName,
      installReferrerSources: [() => ours],
    },
    options,
  );

const ios = (options: LaunchOptions = {}): Launch =>
  launch({ platform: 'ios', iosBundleId: bundleId }, options);

const matching = (options: LaunchOptions = {}): Launch =>
  ios({
    allowProbabilisticMatching: true,
    deviceFamily: () => 'iphone',
    locale: () => 'en-GB',
    ...options,
  });

/** Starts the SDK and waits until the check has left `checking`. */
async function run(launched: Launch): Promise<Launch> {
  await launched.sdk.initialize();
  await vi.waitFor(
    () => {
      expect(['checking', 'pending']).not.toContain(launched.sdk.deferredLinkStatus);
    },
    { interval: 5 },
  );
  return launched;
}

async function until(launched: Launch, status: DeferredLinkStatus): Promise<void> {
  await vi.waitFor(() => expect(launched.sdk.deferredLinkStatus).toBe(status), { interval: 5 });
}

const deferredLink = {
  url: invite,
  linkId: 'link_d',
  appId: 'app_1',
  routePath: '/invite/abc123',
  payload: { invitationId: 'abc123' },
  campaign: { source: 'instagram' },
  isDeferred: true,
  isProbabilisticMatch: false,
};

describe('finding the click id in a referrer', () => {
  it.each([
    [`strybok_click=${clickId}`, clickId],
    [`utm_source=x&strybok_click=${clickId}&utm_medium=y`, clickId],
    [`strybok_click=${clickId}&strybok_click=${otherClickId}`, clickId],
    // Still encoded, in any letter case.
    [`strybok_click%3D${clickId}`, clickId],
    [`utm_source%3Dx%26strybok_click%3d${clickId}%26utm_medium%3Dy`, clickId],
    [`STRYBOK_CLICK%3D${clickId}`, null], // Decoded, the key is not exactly ours.
    ['', null],
    ['utm_source=google-play&utm_medium=organic', null],
    ['strybok_click', null],
    ['strybok_click=', null],
    [`strybok_click=${clickId}x`, null],
    [`strybok_click=${clickId.slice(0, -1)}`, null],
    [`strybok_click=dc_${'!'.repeat(32)}`, null],
    [`strybok_click=xx_${'a'.repeat(32)}`, null],
    // The first part with our key decides, even when a later one would be valid.
    [`strybok_click=nope&strybok_click=${clickId}`, null],
    // A key of ours is present, so nothing is decoded.
    [`strybok_click=bad&x=strybok_click%3D${clickId}`, null],
    // A key that merely ends in or starts with ours.
    [`xstrybok_click=${clickId}`, null],
    [`strybok_click2=${clickId}`, null],
    [` strybok_click=${clickId}`, null],
    // Encoded twice: decoded once only.
    [`strybok_click%253D${clickId}`, null],
    // Malformed percent-encoding next to an encoded key.
    [`strybok_click%3D${clickId}%E0%A4%A`, null],
    [`%zzstrybok_click%3D${clickId}`, null],
  ])('%j → %j', (input, expected) => {
    expect(findClickId(input)).toBe(expected);
  });
});

describe('finding the click id in a pasted text', () => {
  const hosts = new Set([host]);

  it.each([
    [pasted, clickId],
    [`  ${pasted}\n`, clickId],
    [`${invite}?utm_source=x&strybok_click=${clickId}#top`, clickId],
    [`https://MY-APP.strybok.link/invite777?strybok_click=${clickId}`, clickId],
    [`${invite}?strybok_click=${clickId}&strybok_click=nope`, clickId],
    [`${invite}?strybok%5Fclick=${clickId}`, clickId], // Decoded like any query parameter.
    [`${invite}?strybok_click=nope&strybok_click=${clickId}`, null],
    [invite, null],
    [`${invite}?strybok_click=`, null],
    [`${invite}?strybok_click=${clickId}x`, null],
    [`${invite}?strybok_click=%E0%A4%A`, null],
    [`${invite}#strybok_click=${clickId}`, null],
    [`https://evil.example/invite777?strybok_click=${clickId}`, null],
    [`http://${host}/invite777?strybok_click=${clickId}`, null],
    [`https://${host}:8443/invite777?strybok_click=${clickId}`, null],
    [`https://user@${host}/invite777?strybok_click=${clickId}`, null],
    [`https://${host}/a/b?strybok_click=${clickId}`, null],
    [`see ${pasted}`, null],
    [`strybok_click=${clickId}`, null],
    [clickId, null],
    ['my password', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
    [{ toString: () => pasted }, null],
  ])('%j → %j', (input, expected) => {
    expect(pastedClickId(input, hosts)).toBe(expected);
  });
});

describe('options', () => {
  const base: StrybokOptions = {
    apiBaseUrl,
    allowedHosts: [host],
    linkSource: new FakeLinkSource(),
    fetch: new Server().fetch,
  };

  it('is off by default: no source is asked, no request is made, nothing is stored', async () => {
    const store = new MemoryStore();
    const source = vi.fn(() => ours);
    const { sdk, server, links } = android({
      deferredLinks: undefined,
      store,
      installReferrerSources: [source],
    });
    expect(sdk.deferredLinkStatus).toBe('disabled');
    await sdk.initialize();
    await settle();
    expect(sdk.deferredLinkStatus).toBe('disabled');
    expect(await sdk.redeemPastedLink(pasted)).toBe('disabled');
    sdk.skipPastedLink();
    await settle();
    expect(source).not.toHaveBeenCalled();
    expect(server.total).toBe(0);
    expect(store.reads).toBe(0);
    expect(store.writes).toEqual([]);
    expect(links).toEqual([]);
  });

  it('resolved links say isDeferred and isProbabilisticMatch false by default', async () => {
    const { sdk, links } = android({
      deferredLinks: false,
      source: new FakeLinkSource({ initialUrl: invite }),
    });
    await sdk.initialize();
    expect(links).toMatchObject([{ isDeferred: false, isProbabilisticMatch: false }]);
    expect(await sdk.resolveUrl(invite)).toMatchObject({
      isDeferred: false,
      isProbabilisticMatch: false,
    });
  });

  it.each([
    ['no store', { deferredLinkStore: undefined }],
    ['no package name', { androidPackageName: undefined }],
    ['an empty package name', { androidPackageName: '' }],
    ['an unknown platform', { platform: 'unknown' as const }],
    ['no platform', { platform: undefined }],
  ])('stays disabled with %s', async (_name, override) => {
    const source = vi.fn(() => ours);
    const launched = android({ installReferrerSources: [source], ...override });
    const { sdk, server, store } = launched;
    expect(sdk.deferredLinkStatus).toBe('disabled');
    await sdk.initialize();
    sdk.enableDeferredLinks();
    await settle();
    expect(sdk.deferredLinkStatus).toBe('disabled');
    expect(await sdk.redeemPastedLink(pasted)).toBe('disabled');
    expect(source).not.toHaveBeenCalled();
    expect(server.total).toBe(0);
    expect(store.writes).toEqual([]);
    expect(launched.statuses).toEqual([]);
  });

  it.each([
    ['no store', { deferredLinkStore: undefined }],
    ['no bundle id', { iosBundleId: undefined }],
    ['an empty bundle id', { iosBundleId: '' }],
  ])('stays disabled on iOS with %s', async (_name, override) => {
    const { sdk, server } = matching(override);
    await sdk.initialize();
    await settle();
    expect(sdk.deferredLinkStatus).toBe('disabled');
    expect(await sdk.redeemPastedLink(pasted)).toBe('disabled');
    expect(server.total).toBe(0);
  });

  it('rejects options of the wrong type early', () => {
    const invalid: Partial<Record<keyof StrybokOptions, unknown>>[] = [
      { deferredLinks: 'yes' },
      { allowProbabilisticMatching: 1 },
      { deferredLinkStore: {} },
      { deferredLinkStore: { getItem: () => null } },
      { deferredLinkStore: 'localStorage' },
      { installReferrerSources: () => ours },
      { installReferrerSources: 'play' },
      { installReferrerSources: [ours] },
      { androidPackageName: 42 },
      { iosBundleId: {} },
      { deviceFamily: 'iphone' },
      { locale: 'en-GB' },
      { pasteboardMayContainLink: true },
    ];
    for (const override of invalid) {
      expect(
        () => new Strybok({ ...base, ...override } as StrybokOptions),
        JSON.stringify(override),
      ).toThrow(TypeError);
    }
  });

  it('is pending before the start when everything is in place', () => {
    expect(android().sdk.deferredLinkStatus).toBe('pending');
    expect(ios().sdk.deferredLinkStatus).toBe('pending');
  });
});

describe('Android: the flow', () => {
  it('delivers the link of the click id on the first launch', async () => {
    const { sdk, server, store, links, errors, statuses } = await run(android());
    expect(sdk.deferredLinkStatus).toBe('delivered');
    expect(statuses).toEqual(['checking', 'delivered']);
    expect(links).toEqual([deferredLink]);
    expect(store.writes).toEqual([`${ATTEMPTS_KEY}=1`, `${DONE_KEY}=1`]);
    expect(errors).toEqual([]);
    expect(server.redeems).toHaveLength(1);
    expect(server.resolves).toEqual([]);
  });

  it('sends exactly the click id, the package name and the SDK version', async () => {
    const { server } = await run(
      android({
        installReferrerSources: [
          () => referrer(`utm_source=google&strybok_click=${clickId}&gclid=secret`),
        ],
      }),
    );
    expect(server.redeems).toEqual([
      {
        url: redeemUrl,
        init: expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: `{"platform":"android","clickId":"${clickId}","packageName":"${packageName}","sdkVersion":"${SDK_VERSION}"}`,
        }) as FetchRequestInit,
      },
    ]);
  });

  it('keeps a path prefix of apiBaseUrl and the SDK version of an adapter', async () => {
    const server = new Server();
    const requests: Recorded[] = [];
    await run(
      android({
        apiBaseUrl: `${apiBaseUrl}/proxy/`,
        sdkVersion: '0.3.0+react-native',
        fetch: (url, init) => {
          requests.push({ url, init });
          return server.fetch(redeemUrl, init);
        },
      }),
    );
    expect(requests.map((request) => request.url)).toEqual([
      `${apiBaseUrl}/proxy/v1/public/deferred-links/redeem`,
    ]);
    expect(JSON.parse(requests[0]?.init.body ?? '')).toMatchObject({
      sdkVersion: '0.3.0+react-native',
    });
  });

  it('does not delay initialize, getInitialLink or createLink while a source hangs', async () => {
    const source = vi.fn(() => never<InstallReferrerAnswer>());
    const { sdk, server, store } = android({
      installReferrerSources: [source],
      source: new FakeLinkSource({ initialUrl: null }),
    });
    await sdk.initialize();
    expect(await sdk.getInitialLink()).toBeNull();
    await settle();
    expect(source).toHaveBeenCalledTimes(1);
    expect(sdk.deferredLinkStatus).toBe('checking');
    expect(store.writes).toEqual([`${ATTEMPTS_KEY}=1`]);
    expect(server.total).toBe(0);
  });

  it('does not run before initialize', async () => {
    const source = vi.fn(() => ours);
    const { sdk, server, store } = android({ installReferrerSources: [source] });
    await settle();
    expect(sdk.deferredLinkStatus).toBe('pending');
    expect(source).not.toHaveBeenCalled();
    expect(store.reads).toBe(0);
    expect(server.total).toBe(0);
  });

  it('stores the attempt before the first source is asked', async () => {
    const store = new MemoryStore();
    const seen: (string | undefined)[] = [];
    await run(
      android({
        store,
        installReferrerSources: [
          () => {
            seen.push(store.attempts);
            return ours;
          },
        ],
      }),
    );
    expect(seen).toEqual(['1']);
  });

  it('runs once per process, however often initialize is called', async () => {
    const source = vi.fn(() => ours);
    const launched = android({ installReferrerSources: [source] });
    await Promise.all([launched.sdk.initialize(), launched.sdk.initialize()]);
    await run(launched);
    launched.sdk.enableDeferredLinks();
    await launched.sdk.initialize();
    await settle();
    expect(source).toHaveBeenCalledTimes(1);
    expect(launched.server.redeems).toHaveLength(1);
    expect(launched.links).toHaveLength(1);
  });

  it('does nothing on a later launch', async () => {
    const store = new MemoryStore();
    await run(android({ store }));
    const source = vi.fn(() => ours);
    const second = await run(android({ store, installReferrerSources: [source] }));
    expect(second.sdk.deferredLinkStatus).toBe('notFirstLaunch');
    expect(second.statuses).toEqual(['checking', 'notFirstLaunch']);
    expect(source).not.toHaveBeenCalled();
    expect(second.server.total).toBe(0);
    expect(second.links).toEqual([]);
    expect(store.writes).toHaveLength(2);
  });

  it('asks the sources in order and stops at the first click id', async () => {
    const asked: string[] = [];
    const source =
      (name: string, answer: InstallReferrerAnswer): InstallReferrerSource =>
      () => {
        asked.push(name);
        return Promise.resolve(answer);
      };
    const { server } = await run(
      android({
        installReferrerSources: [
          source('play', referrer('utm_source=google-play')),
          source('galaxy', forGood),
          source('huawei', referrer(`strybok_click=${otherClickId}`)),
          source('never asked', ours),
        ],
      }),
    );
    expect(asked).toEqual(['play', 'galaxy', 'huawei']);
    expect(JSON.parse(server.redeems[0]?.init.body ?? '')).toMatchObject({
      clickId: otherClickId,
    });
  });

  it.each<[string, InstallReferrerAnswer[], DeferredLinkStatus, boolean]>([
    ['no source at all', [], 'unavailable', true],
    ['only sources that can never answer', [forGood, forGood], 'unavailable', true],
    [
      'an ordinary referrer',
      [referrer('utm_source=google-play&utm_medium=organic')],
      'noReferrer',
      true,
    ],
    ['an empty referrer', [referrer('')], 'noReferrer', true],
    ['a referrer and a missing store', [forGood, referrer('x=1')], 'noReferrer', true],
    ['a malformed click id', [referrer('strybok_click=dc_short')], 'noReferrer', true],
    ['a store that cannot be asked now', [forNow], 'pending', false],
    ['one store for now, one for good', [forGood, forNow], 'pending', false],
    ['an ordinary referrer and a store for now', [referrer('x=1'), forNow], 'pending', false],
  ])('%s → %s', async (_name, answers, status, done) => {
    const launched = android({ installReferrerSources: answers.map((answer) => () => answer) });
    await launched.sdk.initialize();
    await until(launched, status);
    expect(launched.store.done).toBe(done);
    expect(launched.store.attempts).toBe('1');
    expect(launched.server.total).toBe(0);
    expect(launched.links).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it.each<[string, InstallReferrerSource]>([
    [
      'a source that throws',
      () => {
        throw new Error('boom');
      },
    ],
    ['a source that rejects', () => Promise.reject(new Error('boom'))],
    ['an answer of the wrong shape', () => 'strybok_click=x' as unknown as InstallReferrerAnswer],
    ['a referrer that is not a string', () => ({ status: 'referrer' }) as InstallReferrerAnswer],
    ['no answer', () => undefined as unknown as InstallReferrerAnswer],
  ])('%s counts as unavailable for now', async (_name, source) => {
    const launched = android({ installReferrerSources: [source] });
    await launched.sdk.initialize();
    await until(launched, 'pending');
    expect(launched.store.done).toBe(false);
    expect(launched.errors).toEqual([]);
  });

  it('gives a source 10 seconds, then asks the next one', async () => {
    vi.useFakeTimers();
    const second = vi.fn(() => forGood);
    const launched = android({
      installReferrerSources: [() => never<InstallReferrerAnswer>(), second],
    });
    await launched.sdk.initialize();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(second).not.toHaveBeenCalled();
    expect(launched.sdk.deferredLinkStatus).toBe('checking');
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(launched.sdk.deferredLinkStatus).toBe('pending');
    expect(launched.store.done).toBe(false);
  });
});

describe('Android: answers of the server', () => {
  it.each<[string, () => Answer, DeferredLinkStatus]>([
    ['404', () => response(404, '{"error":{"code":"DEFERRED_LINK_NOT_FOUND"}}'), 'notFound'],
    ['400', () => response(400), 'notFound'],
    ['401', () => response(401), 'notFound'],
    ['422', () => response(422), 'notFound'],
    ['a body that is not JSON', () => response(200, '<html>'), 'failed'],
    ['an empty body', () => response(200), 'failed'],
    ['a JSON array', () => response(200, '[]'), 'failed'],
    ['no linkId', () => redeemed({ linkId: undefined }), 'failed'],
    ['no appId', () => redeemed({ appId: 7 }), 'failed'],
    ['a route without a slash', () => redeemed({ routePath: 'invite' }), 'failed'],
    ['a route with two slashes', () => redeemed({ routePath: '//evil.example' }), 'failed'],
    ['deferred missing', () => redeemed({ deferred: undefined }), 'failed'],
    ['deferred not true', () => redeemed({ deferred: 'true' }), 'failed'],
    ['no url', () => redeemed({ url: undefined }), 'failed'],
    ['a url on another host', () => redeemed({ url: 'https://evil.example/invite777' }), 'failed'],
    ['a url that is not a link', () => redeemed({ url: `https://${host}/a/b` }), 'failed'],
    ['a url that is not https', () => redeemed({ url: `http://${host}/invite777` }), 'failed'],
    ['204', () => response(204), 'failed'],
    ['302', () => response(302), 'failed'],
  ])('%s → done, nothing delivered', async (_name, answer, status) => {
    const launched = android();
    launched.server.onRedeem = answer;
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe(status);
    expect(launched.store.done).toBe(true);
    expect(launched.server.redeems).toHaveLength(1); // Never retried.
    expect(launched.links).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it('reads payload and campaign as for resolving', async () => {
    const launched = android();
    launched.server.onRedeem = () =>
      redeemed({ payload: 'text', campaign: { medium: 'social', term: 3 }, extra: [1] });
    await run(launched);
    expect(launched.links).toEqual([
      { ...deferredLink, payload: {}, campaign: { medium: 'social' } },
    ]);
  });

  it('does not retry 429 in this launch and tries again on the next', async () => {
    const store = new MemoryStore();
    const first = android({ store });
    first.server.onRedeem = () => response(429);
    await first.sdk.initialize();
    await settle(40);
    expect(first.sdk.deferredLinkStatus).toBe('pending');
    expect(first.server.redeems).toHaveLength(1);
    expect(store.done).toBe(false);
    expect(first.errors).toEqual([]);

    const second = await run(android({ store }));
    expect(second.sdk.deferredLinkStatus).toBe('delivered');
    expect(store.attempts).toBe('2');
  });

  it.each<[string, () => Answer]>([
    ['500', () => response(500)],
    ['503', () => response(503)],
    ['a transport failure', () => Promise.reject(new Error('offline'))],
    ['no answer in time', () => never<FetchResponseLike>()],
  ])('retries %s with the identical body, then is pending', async (_name, answer) => {
    const launched = android({ maxRetries: 2, timeoutMs: 20 });
    launched.server.onRedeem = answer;
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(3));
    await until(launched, 'pending');
    expect(new Set(launched.server.redeems.map((request) => request.init.body)).size).toBe(1);
    expect(launched.store.done).toBe(false);
    expect(launched.links).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it('delivers when a retry succeeds', async () => {
    const launched = android();
    let calls = 0;
    launched.server.onRedeem = () => (++calls < 3 ? response(502) : redeemed());
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(launched.links).toHaveLength(1);
  });

  it('makes no extra attempt with maxRetries 0', async () => {
    const launched = android({ maxRetries: 0 });
    launched.server.onRedeem = () => response(500);
    await launched.sdk.initialize();
    await settle(40);
    expect(launched.server.redeems).toHaveLength(1);
    expect(launched.sdk.deferredLinkStatus).toBe('pending');
  });
});

describe('Android: crashes and the once-only guarantee', () => {
  it('gives up after three launches that could not finish', async () => {
    const store = new MemoryStore();
    for (const attempts of ['1', '2', '3']) {
      // The process dies while the store is being asked.
      const launched = android({
        store,
        installReferrerSources: [() => never<InstallReferrerAnswer>()],
      });
      await launched.sdk.initialize();
      await settle();
      expect(store.attempts).toBe(attempts);
      expect(store.done).toBe(false);
      launched.sdk.dispose();
    }
    const source = vi.fn(() => ours);
    const fourth = await run(android({ store, installReferrerSources: [source] }));
    expect(fourth.sdk.deferredLinkStatus).toBe('failed');
    expect(store.done).toBe(true);
    expect(store.attempts).toBe('3');
    expect(source).not.toHaveBeenCalled();
    expect(fourth.server.total).toBe(0);

    const fifth = await run(android({ store, installReferrerSources: [source] }));
    expect(fifth.sdk.deferredLinkStatus).toBe('notFirstLaunch');
    expect(source).not.toHaveBeenCalled();
  });

  it('uses the three attempts for transient failures too', async () => {
    const store = new MemoryStore();
    for (let launchNumber = 1; launchNumber <= 3; launchNumber++) {
      const launched = android({ store, maxRetries: 0 });
      launched.server.onRedeem = () => response(503);
      await launched.sdk.initialize();
      await settle();
      expect(launched.sdk.deferredLinkStatus).toBe('pending');
    }
    const last = await run(android({ store }));
    expect(last.sdk.deferredLinkStatus).toBe('failed');
    expect(last.server.total).toBe(0);
    expect(last.links).toEqual([]);
  });

  it('sends the same id again after a launch that died during the request', async () => {
    const store = new MemoryStore();
    const first = android({ store });
    first.server.onRedeem = () => never<FetchResponseLike>();
    await first.sdk.initialize();
    await vi.waitFor(() => expect(first.server.redeems).toHaveLength(1));
    first.sdk.dispose();
    expect(store.done).toBe(false);

    const second = await run(android({ store }));
    expect(second.sdk.deferredLinkStatus).toBe('delivered');
    expect(second.server.redeems[0]?.init.body).toBe(first.server.redeems[0]?.init.body);
    expect(store.attempts).toBe('2');
  });

  it('stores done before the link is handed to the app', async () => {
    const store = new MemoryStore();
    const launched = android({ store, listen: false });
    const doneAtDelivery: boolean[] = [];
    launched.sdk.onLink(() => doneAtDelivery.push(store.done));
    await run(launched);
    await settle();
    expect(doneAtDelivery).toEqual([true]);

    // A crash right after delivery: the next launch delivers nothing.
    const next = await run(android({ store }));
    expect(next.links).toEqual([]);
    expect(next.server.total).toBe(0);
  });

  it('delivers nothing when done cannot be stored', async () => {
    const store = new MemoryStore();
    store.failWritesTo = DONE_KEY;
    const launched = await run(android({ store }));
    expect(launched.sdk.deferredLinkStatus).toBe('failed');
    expect(launched.links).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it('stops without asking anyone when the attempt cannot be stored', async () => {
    const store = new MemoryStore();
    store.failWritesTo = ATTEMPTS_KEY;
    const source = vi.fn(() => ours);
    const launched = android({ store, installReferrerSources: [source] });
    await launched.sdk.initialize();
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('pending');
    expect(source).not.toHaveBeenCalled();
    expect(launched.server.total).toBe(0);
  });

  it('stops without asking anyone when the storage cannot be read', async () => {
    const store = new MemoryStore();
    store.failReads = true;
    const source = vi.fn(() => ours);
    const launched = android({ store, installReferrerSources: [source] });
    await launched.sdk.initialize();
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('pending');
    expect(source).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(launched.server.total).toBe(0);
  });

  it('survives a storage that throws synchronously', async () => {
    const launched = android({
      deferredLinkStore: {
        getItem: () => {
          throw new Error('no storage');
        },
        setItem: () => undefined,
      },
    });
    await launched.sdk.initialize();
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('pending');
    expect(launched.server.total).toBe(0);
  });

  it('works with a synchronous store', async () => {
    const data = new Map<string, string>();
    const launched = await run(
      android({
        deferredLinkStore: {
          getItem: (key) => data.get(key),
          setItem: (key, value) => void data.set(key, value),
        },
      }),
    );
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(Object.fromEntries(data)).toEqual({ [ATTEMPTS_KEY]: '1', [DONE_KEY]: '1' });
  });

  it.each(['many', '-1', '1.5', ''])('treats the stored attempts %j as used up', async (stored) => {
    const store = new MemoryStore();
    store.data.set(ATTEMPTS_KEY, stored);
    const launched = await run(android({ store }));
    expect(launched.sdk.deferredLinkStatus).toBe('failed');
    expect(store.done).toBe(true);
    expect(launched.server.total).toBe(0);
  });

  it('stores nothing but the attempts and the done flag', async () => {
    const launched = await run(
      android({
        installReferrerSources: [() => referrer(`gclid=private&strybok_click=${clickId}`)],
      }),
    );
    const stored = JSON.stringify([...launched.store.data]);
    expect([...launched.store.data.keys()]).toEqual([ATTEMPTS_KEY, DONE_KEY]);
    expect(stored).not.toContain(clickId);
    expect(stored).not.toContain('gclid');
  });
});

describe('Android: a normal link wins', () => {
  it('makes no request when the app was opened by a link', async () => {
    const launched = await run(android({ source: new FakeLinkSource({ initialUrl: invite }) }));
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.server.redeems).toEqual([]);
    expect(launched.store.done).toBe(true);
    expect(launched.links).toMatchObject([{ linkId: 'link_n', isDeferred: false }]);
  });

  it('counts a link of ours that failed to resolve, too', async () => {
    const launched = android({ source: new FakeLinkSource({ initialUrl: invite }) });
    launched.server.onResolve = () => response(404);
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.server.redeems).toEqual([]);
    expect(launched.errors).toHaveLength(1); // The normal link's own error, nothing else.
  });

  it('ignores URLs that are not ours', async () => {
    const launched = await run(
      android({ source: new FakeLinkSource({ initialUrl: 'https://other.example/x' }) }),
    );
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
  });

  it('ignores a link resolved by hand', async () => {
    const launched = android({
      installReferrerSources: [
        async () => {
          await settle();
          return ours;
        },
      ],
    });
    await launched.sdk.initialize();
    await launched.sdk.resolveUrl(invite);
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
  });

  it('drops the deferred link when a link arrives while the source is asked', async () => {
    let answer: (value: InstallReferrerAnswer) => void = () => {};
    const launched = android({
      installReferrerSources: [() => new Promise((resolve) => (answer = resolve))],
    });
    await launched.sdk.initialize();
    await settle();
    launched.source.emit(invite);
    answer(ours);
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.server.redeems).toEqual([]);
  });

  it('drops the deferred link when a link arrives while the request is in flight', async () => {
    let answer: (value: FetchResponseLike) => void = () => {};
    const launched = android();
    launched.server.onRedeem = () => new Promise((resolve) => (answer = resolve));
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(1));
    launched.source.emit(invite);
    await settle();
    answer(redeemed());
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.store.done).toBe(true);
    expect(launched.links).toMatchObject([{ linkId: 'link_n' }]);

    // Never delivered later either.
    const next = await run(android({ store: launched.store }));
    expect(next.links).toEqual([]);
  });

  it('drops the deferred link when a link arrives while done is being stored', async () => {
    const store = new MemoryStore();
    const launched = android({ store });
    const setItem = store.setItem.bind(store);
    store.setItem = async (key, value) => {
      if (key === DONE_KEY) launched.source.emit(invite);
      await setItem(key, value);
    };
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.links).toMatchObject([{ linkId: 'link_n' }]);
  });

  it('delivers a normal link that arrives after the deferred one', async () => {
    const launched = await run(android());
    launched.source.emit(invite);
    await settle();
    expect(launched.links.map((link) => link.isDeferred)).toEqual([true, false]);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
  });
});

describe('Android: delivery', () => {
  it('queues the link until a listener attaches, and never returns it as the initial link', async () => {
    const launched = await run(android({ listen: false }));
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(await launched.sdk.getInitialLink()).toBeNull();
    expect(await launched.sdk.getInitialLink()).toBeNull();

    const first: ResolvedLink[] = [];
    const second: ResolvedLink[] = [];
    launched.sdk.onLink((link) => first.push(link));
    await settle();
    launched.sdk.onLink((link) => second.push(link));
    await settle();
    expect(first).toEqual([deferredLink]);
    expect(second).toEqual([]); // Exactly once.
  });

  it('sends no app_open for a deferred link', async () => {
    const launched = await run(android({ reportAppOpens: true }));
    await settle();
    expect(launched.links).toHaveLength(1);
    expect(launched.server.events).toEqual([]);
  });

  it('is not held back by the duplicate window of the same URL', async () => {
    const launched = await run(android());
    launched.source.emit(invite); // The same URL as the deferred link, right after it.
    await settle();
    expect(launched.links.map((link) => link.linkId)).toEqual(['link_d', 'link_n']);
  });

  it('delivers nothing after dispose, but stores done when the answer had arrived', async () => {
    let answer: (value: FetchResponseLike) => void = () => {};
    const launched = android();
    launched.server.onRedeem = () => new Promise((resolve) => (answer = resolve));
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(1));
    launched.sdk.dispose();
    answer(redeemed());
    await settle();
    expect(launched.links).toEqual([]);
    expect(launched.store.done).toBe(true);
    expect(launched.statuses).toEqual(['checking']);
  });

  it('stops asking sources after dispose', async () => {
    let answer: (value: InstallReferrerAnswer) => void = () => {};
    const second = vi.fn(() => ours);
    const launched = android({
      installReferrerSources: [() => new Promise((resolve) => (answer = resolve)), second],
    });
    await launched.sdk.initialize();
    await settle();
    launched.sdk.dispose();
    answer(forGood);
    await settle();
    expect(second).not.toHaveBeenCalled();
    expect(launched.server.total).toBe(0);
    expect(launched.store.done).toBe(false);
  });
});

describe('switching deferred links on later', () => {
  it('runs the check once when enabled after the start', async () => {
    const source = vi.fn(() => ours);
    const launched = android({ deferredLinks: false, installReferrerSources: [source] });
    await launched.sdk.initialize();
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('disabled');
    expect(launched.store.reads).toBe(0);

    launched.sdk.enableDeferredLinks();
    launched.sdk.enableDeferredLinks();
    await run(launched);
    launched.sdk.enableDeferredLinks();
    await settle();
    expect(launched.statuses).toEqual(['pending', 'checking', 'delivered']);
    expect(source).toHaveBeenCalledTimes(1);
    expect(launched.links).toHaveLength(1);
  });

  it('waits for the start when enabled before it', async () => {
    const source = vi.fn(() => ours);
    const launched = android({ deferredLinks: false, installReferrerSources: [source] });
    launched.sdk.enableDeferredLinks();
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('pending');
    expect(source).not.toHaveBeenCalled();
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
  });

  it('is superseded when a link opened the app before consent was given', async () => {
    const launched = android({
      deferredLinks: false,
      source: new FakeLinkSource({ initialUrl: invite }),
    });
    await launched.sdk.initialize();
    launched.sdk.enableDeferredLinks();
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.server.redeems).toEqual([]);
  });

  it('does nothing after dispose', async () => {
    const launched = android({ deferredLinks: false });
    await launched.sdk.initialize();
    launched.sdk.dispose();
    launched.sdk.enableDeferredLinks();
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('disabled');
    expect(launched.server.total).toBe(0);
  });
});

describe('status listeners', () => {
  it('can be removed, and a throwing one does not disturb the check', async () => {
    const launched = android();
    const seen: DeferredLinkStatus[] = [];
    const remove = launched.sdk.onDeferredLinkStatus((status) => {
      seen.push(status);
      remove();
    });
    launched.sdk.onDeferredLinkStatus(() => {
      throw new Error('listener bug');
    });
    // The exceptions are rethrown from timers, outside of the check.
    vi.useFakeTimers();
    await launched.sdk.initialize();
    const thrown: unknown[] = [];
    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(0).catch((error: unknown) => thrown.push(error));
    }
    expect(seen).toEqual(['checking']);
    expect(launched.statuses).toEqual(['checking', 'delivered']);
    expect(thrown[0]).toMatchObject({ message: 'listener bug' });
    expect(() => launched.sdk.onDeferredLinkStatus(null as never)).toThrow(TypeError);
  });
});

describe('iOS: pasted link (flow A)', () => {
  it('asks no source and makes no request by itself', async () => {
    const source = vi.fn(() => ours);
    const launched = await run(ios({ installReferrerSources: [source] }));
    expect(launched.sdk.deferredLinkStatus).toBe('unavailable');
    expect(launched.statuses).toEqual(['checking', 'unavailable']);
    expect(source).not.toHaveBeenCalled();
    expect(launched.server.total).toBe(0);
    expect(launched.store.writes).toEqual([]); // Pasting must stay possible.
  });

  it('exchanges the click id of the pasted link and delivers it', async () => {
    const launched = await run(ios());
    expect(await launched.sdk.redeemPastedLink(`  ${pasted}&utm_source=x \n`)).toBe('delivered');
    expect(launched.links).toEqual([deferredLink]);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(launched.store.writes).toEqual([`${DONE_KEY}=1`]);
    expect(launched.server.redeems).toEqual([
      {
        url: redeemUrl,
        init: expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: `{"platform":"ios","clickId":"${clickId}","bundleId":"${bundleId}","sdkVersion":"${SDK_VERSION}"}`,
        }) as FetchRequestInit,
      },
    ]);
    await settle();
    expect(launched.server.events).toEqual([]);
    expect(launched.server.resolves).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it('works before initialize, queued until a listener attaches', async () => {
    const launched = ios({ listen: false });
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
    const links: ResolvedLink[] = [];
    launched.sdk.onLink((link) => links.push(link));
    expect(await launched.sdk.getInitialLink()).toBeNull();
    await settle();
    expect(links).toEqual([deferredLink]);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
  });

  it.each([
    ['another site', 'https://example.com/invite777'],
    ['a link of ours without an id', invite],
    ['a link of ours with a malformed id', `${invite}?strybok_click=dc_123`],
    ['a link of another app', `https://other.strybok.link/x?strybok_click=${clickId}`],
    ['a bare id', clickId],
    ['a password', 'correct horse battery staple'],
    ['nothing', ''],
    ['not a string', null as unknown as string],
  ])('answers notOurs for %s without any request', async (_name, text) => {
    const launched = await run(ios());
    expect(await launched.sdk.redeemPastedLink(text)).toBe('notOurs');
    expect(launched.server.total).toBe(0);
    expect(launched.store.writes).toEqual([]);
    expect(launched.sdk.deferredLinkStatus).toBe('unavailable');
    // The person can still paste the right thing.
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
  });

  it.each<[string, () => Answer, 'notFound' | 'failed', DeferredLinkStatus]>([
    ['404', () => response(404), 'notFound', 'notFound'],
    ['410', () => response(410), 'notFound', 'notFound'],
    ['an unusable 200', () => response(200, '{}'), 'failed', 'failed'],
    [
      'a url on another host',
      () => redeemed({ url: 'https://evil.example/x' }),
      'failed',
      'failed',
    ],
  ])('%s → done is stored', async (_name, answer, result, status) => {
    const launched = await run(ios());
    launched.server.onRedeem = answer;
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe(result);
    expect(launched.sdk.deferredLinkStatus).toBe(status);
    expect(launched.store.done).toBe(true);
    expect(launched.links).toEqual([]);
    expect(launched.errors).toEqual([]);
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('alreadyHandled');
    expect(launched.server.redeems).toHaveLength(1);
  });

  it.each<[string, () => Answer, number]>([
    ['429', () => response(429), 1],
    ['500', () => response(500), 3],
    ['a transport failure', () => Promise.reject(new Error('offline')), 3],
    ['no answer in time', () => never<FetchResponseLike>(), 3],
  ])('%s → failed, and the person can paste again', async (_name, answer, requests) => {
    const launched = await run(ios({ timeoutMs: 20 }));
    launched.server.onRedeem = answer;
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('failed');
    expect(launched.server.redeems).toHaveLength(requests);
    expect(new Set(launched.server.redeems.map((request) => request.init.body)).size).toBe(1);
    expect(launched.store.done).toBe(false);
    expect(launched.sdk.deferredLinkStatus).toBe('unavailable');
    expect(launched.errors).toEqual([]);

    launched.server.onRedeem = () => redeemed();
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
    expect(launched.links).toHaveLength(1);
  });

  it('answers alreadyHandled on a later launch, without a request', async () => {
    const store = new MemoryStore();
    const first = await run(ios({ store }));
    expect(await first.sdk.redeemPastedLink(pasted)).toBe('delivered');

    const second = await run(ios({ store }));
    expect(second.sdk.deferredLinkStatus).toBe('notFirstLaunch');
    expect(await second.sdk.redeemPastedLink(pasted)).toBe('alreadyHandled');
    expect(await second.sdk.redeemPastedLink('anything')).toBe('alreadyHandled');
    expect(second.server.total).toBe(0);
    expect(second.links).toEqual([]);
  });

  it('delivers a pasted link even after a normal link in the same launch', async () => {
    const launched = await run(ios({ source: new FakeLinkSource({ initialUrl: invite }) }));
    expect(launched.links).toMatchObject([{ linkId: 'link_n' }]);
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
    expect(launched.links.map((link) => link.isDeferred)).toEqual([false, true]);
  });

  it('handles two pastes one after the other', async () => {
    let answer: (value: FetchResponseLike) => void = () => {};
    const launched = await run(ios());
    launched.server.onRedeem = () => new Promise((resolve) => (answer = resolve));
    const first = launched.sdk.redeemPastedLink(pasted);
    const second = launched.sdk.redeemPastedLink(pasted);
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(1));
    answer(redeemed());
    expect(await Promise.all([first, second])).toEqual(['delivered', 'alreadyHandled']);
    expect(launched.server.redeems).toHaveLength(1);
    expect(launched.links).toHaveLength(1);
  });

  it('answers failed when the storage is broken, and never rejects', async () => {
    const store = new MemoryStore();
    const launched = await run(ios({ store }));
    store.failReads = true;
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('failed');
    store.failReads = false;
    store.failWritesTo = DONE_KEY;
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('failed');
    expect(launched.links).toEqual([]); // Not delivered without the done flag.
    expect(launched.server.redeems).toHaveLength(1);
  });

  it('answers disabled after dispose, and failed when disposed during the request', async () => {
    let answer: (value: FetchResponseLike) => void = () => {};
    const launched = await run(ios());
    launched.server.onRedeem = () => new Promise((resolve) => (answer = resolve));
    const result = launched.sdk.redeemPastedLink(pasted);
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(1));
    launched.sdk.dispose();
    answer(redeemed());
    expect(await result).toBe('failed');
    expect(launched.links).toEqual([]);
    expect(launched.store.done).toBe(true);
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('disabled');
  });

  it('answers disabled on Android', async () => {
    const launched = await run(android({ installReferrerSources: [] }));
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('disabled');
    expect(launched.server.total).toBe(0);
  });

  it('becomes available with enableDeferredLinks', async () => {
    const launched = ios({ deferredLinks: false });
    await launched.sdk.initialize();
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('disabled');
    launched.sdk.enableDeferredLinks();
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
  });
});

describe('iOS: probabilistic matching (flow B)', () => {
  it('is off unless allowProbabilisticMatching is set', async () => {
    const deviceFamily = vi.fn(() => 'iphone');
    const launched = await run(ios({ deviceFamily, locale: () => 'en-GB' }));
    expect(launched.sdk.deferredLinkStatus).toBe('unavailable');
    expect(deviceFamily).not.toHaveBeenCalled();
    expect(launched.server.total).toBe(0);
    expect(launched.store.writes).toEqual([]);
  });

  it('is not run on Android', async () => {
    const launched = await run(
      android({
        allowProbabilisticMatching: true,
        deviceFamily: () => 'iphone',
        locale: () => 'en-GB',
        iosBundleId: bundleId,
      }),
    );
    expect(launched.server.matches).toEqual([]);
  });

  it('sends the bundle id, the device family and the language, and marks the link', async () => {
    const launched = await run(matching());
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(launched.statuses).toEqual(['checking', 'delivered']);
    expect(launched.links).toEqual([{ ...deferredLink, isProbabilisticMatch: true }]);
    expect(launched.store.writes).toEqual([`${ATTEMPTS_KEY}=1`, `${DONE_KEY}=1`]);
    expect(launched.server.matches).toEqual([
      {
        url: matchUrl,
        init: expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: `{"platform":"ios","bundleId":"${bundleId}","deviceFamily":"iphone","locale":"en-GB","sdkVersion":"${SDK_VERSION}"}`,
        }) as FetchRequestInit,
      },
    ]);
    await settle();
    expect(launched.server.events).toEqual([]);
    expect(launched.server.redeems).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it.each(['iphone', 'ipad', 'ipod'])('accepts the device family %s', async (family) => {
    const launched = await run(
      matching({
        deviceFamily: () => Promise.resolve(family),
        locale: () => Promise.resolve('uk'),
      }),
    );
    expect(JSON.parse(launched.server.matches[0]?.init.body ?? '')).toMatchObject({
      deviceFamily: family,
      locale: 'uk',
    });
  });

  it.each<[string, Partial<StrybokOptions>]>([
    ['a Mac', { deviceFamily: () => 'mac' }],
    ['iPhone in another spelling', { deviceFamily: () => 'iPhone' }],
    ['no device family', { deviceFamily: () => null }],
    ['no device family callback', { deviceFamily: undefined }],
    ['a device family callback that throws', { deviceFamily: () => Promise.reject(new Error()) }],
    ['no language', { locale: () => undefined }],
    ['no language callback', { locale: undefined }],
    ['an empty language', { locale: () => '' }],
    ['a language the server refuses', { locale: () => 'English (UK)' }],
    [
      'a language callback that throws',
      {
        locale: () => {
          throw new Error('boom');
        },
      },
    ],
  ])('%s → unavailable, done, no request', async (_name, override) => {
    const launched = await run(matching(override));
    expect(launched.sdk.deferredLinkStatus).toBe('unavailable');
    expect(launched.store.writes).toEqual([`${ATTEMPTS_KEY}=1`, `${DONE_KEY}=1`]);
    expect(launched.server.total).toBe(0);
    expect(launched.errors).toEqual([]);
  });

  it.each<[string, () => Answer, DeferredLinkStatus]>([
    ['404', () => response(404), 'notFound'],
    ['422', () => response(422), 'notFound'],
    ['matched missing', () => redeemed(), 'failed'],
    ['matched something else', () => matched({ matched: 'exact' }), 'failed'],
    ['deferred not true', () => matched({ deferred: false }), 'failed'],
    ['a url on another host', () => matched({ url: 'https://evil.example/x' }), 'failed'],
    ['not JSON', () => response(200, 'ok'), 'failed'],
  ])('%s → done, nothing delivered', async (_name, answer, status) => {
    const launched = matching();
    launched.server.onMatch = answer;
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe(status);
    expect(launched.store.done).toBe(true);
    expect(launched.server.matches).toHaveLength(1);
    expect(launched.links).toEqual([]);
    expect(launched.errors).toEqual([]);
  });

  it.each<[string, () => Answer, number]>([
    ['429', () => response(429), 1],
    ['500', () => response(500), 3],
    ['a transport failure', () => Promise.reject(new Error('offline')), 3],
    ['no answer in time', () => never<FetchResponseLike>(), 3],
  ])('%s → pending, a later launch tries again', async (_name, answer, requests) => {
    const launched = matching({ timeoutMs: 20 });
    launched.server.onMatch = answer;
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.matches).toHaveLength(requests));
    await until(launched, 'pending');
    await settle(40);
    expect(launched.server.matches).toHaveLength(requests);
    expect(launched.store.done).toBe(false);

    const next = await run(matching({ store: launched.store }));
    expect(next.sdk.deferredLinkStatus).toBe('delivered');
    expect(next.store.attempts).toBe('2');
  });

  it('gives up after three attempts', async () => {
    const store = new MemoryStore();
    for (let launchNumber = 1; launchNumber <= 3; launchNumber++) {
      const launched = matching({ store, maxRetries: 0 });
      launched.server.onMatch = () => response(503);
      await launched.sdk.initialize();
      await until(launched, 'pending');
    }
    const last = await run(matching({ store }));
    expect(last.sdk.deferredLinkStatus).toBe('failed');
    expect(last.server.total).toBe(0);
    expect(store.done).toBe(true);
    const after = await run(matching({ store }));
    expect(after.sdk.deferredLinkStatus).toBe('notFirstLaunch');
  });

  it('a normal link wins before the request', async () => {
    const launched = await run(matching({ source: new FakeLinkSource({ initialUrl: invite }) }));
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.server.matches).toEqual([]);
    expect(launched.store.writes).toEqual([`${ATTEMPTS_KEY}=1`, `${DONE_KEY}=1`]);
  });

  it('a normal link wins during the request', async () => {
    let answer: (value: FetchResponseLike) => void = () => {};
    const launched = matching();
    launched.server.onMatch = () => new Promise((resolve) => (answer = resolve));
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.matches).toHaveLength(1));
    launched.source.emit(invite);
    await settle();
    answer(matched());
    await run(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.links).toMatchObject([{ linkId: 'link_n', isProbabilisticMatch: false }]);
  });

  it('stores done before delivery and never returns the link as the initial link', async () => {
    const store = new MemoryStore();
    const launched = matching({ store, listen: false });
    await run(launched);
    expect(await launched.sdk.getInitialLink()).toBeNull();
    const doneAtDelivery: boolean[] = [];
    launched.sdk.onLink(() => doneAtDelivery.push(store.done));
    await settle();
    expect(doneAtDelivery).toEqual([true]);
  });

  describe('clipboard first', () => {
    const awaiting = async (options: LaunchOptions = {}): Promise<Launch> => {
      const launched = matching({ pasteboardMayContainLink: () => true, ...options });
      await launched.sdk.initialize();
      await until(launched, 'awaitingPaste');
      return launched;
    };

    it('waits for the paste when the clipboard may hold a link', async () => {
      const launched = await awaiting();
      await settle();
      expect(launched.server.total).toBe(0);
      expect(launched.store.writes).toEqual([]);
      expect(launched.statuses).toEqual(['checking', 'awaitingPaste']);
    });

    it.each<[string, () => boolean | Promise<boolean>]>([
      ['false', () => false],
      ['a promise of false', () => Promise.resolve(false)],
      ['a rejection', () => Promise.reject(new Error('no pasteboard'))],
      ['something that is not true', () => 'yes' as unknown as boolean],
    ])('matches at once when the probe answers %s', async (_name, probe) => {
      const launched = await run(matching({ pasteboardMayContainLink: probe }));
      expect(launched.sdk.deferredLinkStatus).toBe('delivered');
      expect(launched.server.matches).toHaveLength(1);
    });

    it('matches after a paste that is not ours', async () => {
      const launched = await awaiting();
      expect(await launched.sdk.redeemPastedLink('https://example.com/')).toBe('notOurs');
      await until(launched, 'delivered');
      expect(launched.server.matches).toHaveLength(1);
      expect(launched.server.redeems).toEqual([]);
      expect(launched.links).toMatchObject([{ isProbabilisticMatch: true }]);
      expect(launched.statuses).toEqual(['checking', 'awaitingPaste', 'checking', 'delivered']);
    });

    it('matches after skipPastedLink, once', async () => {
      const launched = await awaiting();
      launched.sdk.skipPastedLink();
      launched.sdk.skipPastedLink();
      await until(launched, 'delivered');
      launched.sdk.skipPastedLink();
      await settle();
      expect(launched.server.matches).toHaveLength(1);
      expect(launched.links).toHaveLength(1);
    });

    it('never matches when the pasted link is ours', async () => {
      const launched = await awaiting();
      expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
      launched.sdk.skipPastedLink();
      await settle();
      expect(launched.server.matches).toEqual([]);
      expect(launched.links).toEqual([deferredLink]);
      expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    });

    it('keeps waiting when the paste failed for now', async () => {
      const launched = await awaiting();
      launched.server.onRedeem = () => response(429);
      expect(await launched.sdk.redeemPastedLink(pasted)).toBe('failed');
      await settle();
      expect(launched.sdk.deferredLinkStatus).toBe('awaitingPaste');
      expect(launched.server.matches).toEqual([]);
    });

    it('never matches after a pasted link the server refused', async () => {
      const launched = await awaiting();
      launched.server.onRedeem = () => response(404);
      expect(await launched.sdk.redeemPastedLink(pasted)).toBe('notFound');
      launched.sdk.skipPastedLink();
      await settle();
      expect(launched.server.matches).toEqual([]);
      expect(launched.sdk.deferredLinkStatus).toBe('notFound');
    });

    it('skipPastedLink does nothing when nothing is awaited', async () => {
      const launched = await run(ios());
      launched.sdk.skipPastedLink();
      await settle();
      expect(launched.server.total).toBe(0);
      expect(launched.sdk.deferredLinkStatus).toBe('unavailable');
    });

    it('does not ask the probe when matching is off or the check is finished', async () => {
      const probe = vi.fn(() => true);
      const store = new MemoryStore();
      await run(ios({ store, pasteboardMayContainLink: probe }));
      store.data.set(DONE_KEY, '1');
      await run(matching({ store, pasteboardMayContainLink: probe }));
      expect(probe).not.toHaveBeenCalled();
    });
  });

  it('delivers one link when a paste and a match finish together', async () => {
    let answerMatch: (value: FetchResponseLike) => void = () => {};
    let answerRedeem: (value: FetchResponseLike) => void = () => {};
    const launched = matching();
    launched.server.onMatch = () => new Promise((resolve) => (answerMatch = resolve));
    launched.server.onRedeem = () => new Promise((resolve) => (answerRedeem = resolve));
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.matches).toHaveLength(1));
    const result = launched.sdk.redeemPastedLink(pasted);
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(1));
    answerRedeem(redeemed());
    expect(await result).toBe('delivered');
    answerMatch(matched());
    await settle();
    expect(launched.links).toEqual([deferredLink]);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
  });

  it('keeps the status of the pasted link when the match then fails', async () => {
    let answerMatch: (value: FetchResponseLike) => void = () => {};
    const launched = matching({ maxRetries: 0 });
    launched.server.onMatch = () => new Promise((resolve) => (answerMatch = resolve));
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.matches).toHaveLength(1));
    expect(await launched.sdk.redeemPastedLink(pasted)).toBe('delivered');
    answerMatch(response(503));
    await settle();
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(launched.links).toHaveLength(1);
  });

  it('answers alreadyHandled when the match was delivered while the paste was in flight', async () => {
    let answerMatch: (value: FetchResponseLike) => void = () => {};
    let answerRedeem: (value: FetchResponseLike) => void = () => {};
    const launched = matching();
    launched.server.onMatch = () => new Promise((resolve) => (answerMatch = resolve));
    launched.server.onRedeem = () => new Promise((resolve) => (answerRedeem = resolve));
    await launched.sdk.initialize();
    await vi.waitFor(() => expect(launched.server.matches).toHaveLength(1));
    const result = launched.sdk.redeemPastedLink(pasted);
    await vi.waitFor(() => expect(launched.server.redeems).toHaveLength(1));
    answerMatch(matched());
    await until(launched, 'delivered');
    answerRedeem(redeemed());
    expect(await result).toBe('alreadyHandled');
    expect(launched.links).toEqual([{ ...deferredLink, isProbabilisticMatch: true }]);
  });
});
