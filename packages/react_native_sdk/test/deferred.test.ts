// Deferred links through the React Native adapter. The flow itself is tested in `@strybok/js`;
// here: the options reach the core, the platform comes from `Platform.OS`, and nothing happens
// unless the app passed everything the feature needs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStrybok,
  REACT_NATIVE_SDK_VERSION,
  type DeferredLinkStatus,
  type DeferredLinkStore,
  type FetchRequestInit,
  type FetchResponseLike,
  type InstallReferrerAnswer,
  type PastedLinkResult,
  type ResolvedLink,
  type Strybok,
  type StrybokError,
} from '../src/index.js';
import { Linking, Platform } from './fakes/react-native.js';
import { apiBaseUrl, host, invite, settle } from './helpers.js';

const clickId = `dc_${'aB3x'.repeat(8)}`;
const pasted = `${invite}?strybok_click=${clickId}`;

interface Request {
  readonly url: string;
  readonly init: FetchRequestInit;
}

const instances: Strybok[] = [];
let requests: Request[] = [];
let errors: StrybokError[] = [];

/** Shaped like `AsyncStorage`: this is what an app passes as `deferredLinkStore`. */
function asyncStorage(): DeferredLinkStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => Promise.resolve(data.get(key) ?? null),
    setItem: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function fetchStub(url: string, init: FetchRequestInit): Promise<FetchResponseLike> {
  requests.push({ url, init });
  const answer = (status: number, body: unknown): FetchResponseLike => ({
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  if (url.endsWith('/v1/public/events')) return Promise.resolve(answer(202, ''));
  const link = { linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' };
  if (url.endsWith('/deferred-links/redeem')) {
    return Promise.resolve(answer(200, { ...link, url: invite, deferred: true }));
  }
  if (url.endsWith('/deferred-links/match')) {
    return Promise.resolve(
      answer(200, { ...link, url: invite, deferred: true, matched: 'probabilistic' }),
    );
  }
  return Promise.resolve(answer(200, link));
}

function create(overrides: Partial<Parameters<typeof createStrybok>[0]> = {}): Strybok {
  const strybok = createStrybok({
    apiBaseUrl,
    allowedHosts: [host],
    fetch: fetchStub,
    onError: (error) => errors.push(error),
    ...overrides,
  });
  instances.push(strybok);
  return strybok;
}

async function until(strybok: Strybok, status: DeferredLinkStatus): Promise<void> {
  await vi.waitFor(() => expect(strybok.deferredLinkStatus).toBe(status), { interval: 5 });
}

const playReferrer = (): Promise<InstallReferrerAnswer> =>
  Promise.resolve({ status: 'referrer', referrer: `utm_source=google&strybok_click=${clickId}` });

beforeEach(() => {
  Linking.reset();
  Platform.OS = 'android';
  requests = [];
  errors = [];
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

describe('deferred links on Android', () => {
  it('are off by default: no source is asked and no request is made', async () => {
    const source = vi.fn(playReferrer);
    const store = asyncStorage();
    const strybok = create({
      deferredLinkStore: store,
      androidPackageName: 'com.example.app',
      installReferrerSources: [source],
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(source).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(store.data.size).toBe(0);
  });

  it('stay disabled without a store: the adapter has no storage of its own', async () => {
    const source = vi.fn(playReferrer);
    const strybok = create({
      deferredLinks: true,
      androidPackageName: 'com.example.app',
      installReferrerSources: [source],
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(source).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('stay disabled without the package name', async () => {
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: asyncStorage(),
      installReferrerSources: [playReferrer],
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(requests).toEqual([]);
  });

  it('redeem the click id of the app-supplied referrer and deliver the link', async () => {
    const store = asyncStorage();
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: store,
      androidPackageName: 'com.example.app',
      installReferrerSources: [playReferrer],
    });
    const links: ResolvedLink[] = [];
    strybok.onLink((link) => links.push(link));
    await strybok.initialize();
    await until(strybok, 'delivered');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${apiBaseUrl}/v1/public/deferred-links/redeem`);
    expect(requests[0]?.init.body).toBe(
      `{"platform":"android","clickId":"${clickId}","packageName":"com.example.app","sdkVersion":"${REACT_NATIVE_SDK_VERSION}"}`,
    );
    expect(links).toEqual([
      {
        url: invite,
        linkId: 'link_1',
        appId: 'app_1',
        routePath: '/invite/abc123',
        payload: {},
        campaign: {},
        isDeferred: true,
        isProbabilisticMatch: false,
      },
    ]);
    expect(await strybok.getInitialLink()).toBeNull();
    expect([...store.data]).toEqual([
      ['strybok.deferred.attempts', '1'],
      ['strybok.deferred.done', '1'],
    ]);
    await settle();
    expect(requests).toHaveLength(1); // No app_open.
    expect(errors).toEqual([]);
  });

  it('are dropped when a link opened the app', async () => {
    Linking.initialUrl = invite;
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: asyncStorage(),
      androidPackageName: 'com.example.app',
      installReferrerSources: [playReferrer],
      reportAppOpens: false,
    });
    await strybok.initialize();
    await until(strybok, 'superseded');
    expect(requests.map((request) => request.url)).toEqual([
      `${apiBaseUrl}/v1/public/resolve?url=https%3A%2F%2F${host}%2Finvite777`,
    ]);
  });

  it('can be switched on after a consent screen', async () => {
    const strybok = create({
      deferredLinkStore: asyncStorage(),
      androidPackageName: 'com.example.app',
      installReferrerSources: [playReferrer],
    });
    await strybok.initialize();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    strybok.enableDeferredLinks();
    await until(strybok, 'delivered');
  });

  it('do not accept a pasted link', async () => {
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: asyncStorage(),
      androidPackageName: 'com.example.app',
      iosBundleId: 'com.example.App',
    });
    await strybok.initialize();
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('disabled');
  });
});

describe('deferred links on iOS', () => {
  beforeEach(() => {
    Platform.OS = 'ios';
  });

  it('never ask an install referrer source', async () => {
    const source = vi.fn(playReferrer);
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: asyncStorage(),
      iosBundleId: 'com.example.App',
      androidPackageName: 'com.example.app',
      installReferrerSources: [source],
    });
    await strybok.initialize();
    await until(strybok, 'unavailable');
    expect(source).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('redeem the link the person pasted', async () => {
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: asyncStorage(),
      iosBundleId: 'com.example.App',
    });
    const links: ResolvedLink[] = [];
    strybok.onLink((link) => links.push(link));
    await strybok.initialize();

    expect(await strybok.redeemPastedLink('some other text')).toBe<PastedLinkResult>('notOurs');
    expect(requests).toEqual([]);
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('delivered');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.body).toBe(
      `{"platform":"ios","clickId":"${clickId}","bundleId":"com.example.App","sdkVersion":"${REACT_NATIVE_SDK_VERSION}"}`,
    );
    expect(links).toMatchObject([{ url: invite, isDeferred: true, isProbabilisticMatch: false }]);
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('alreadyHandled');
  });

  it('match only with allowProbabilisticMatching, from the callbacks of the app', async () => {
    const options = {
      deferredLinks: true,
      iosBundleId: 'com.example.App',
      deviceFamily: () => 'ipad',
      locale: () => 'uk-UA',
    };
    const without = create({ ...options, deferredLinkStore: asyncStorage() });
    await without.initialize();
    await until(without, 'unavailable');
    expect(requests).toEqual([]);

    const strybok = create({
      ...options,
      deferredLinkStore: asyncStorage(),
      allowProbabilisticMatching: true,
    });
    const links: ResolvedLink[] = [];
    strybok.onLink((link) => links.push(link));
    await strybok.initialize();
    await until(strybok, 'delivered');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${apiBaseUrl}/v1/public/deferred-links/match`);
    expect(requests[0]?.init.body).toBe(
      `{"platform":"ios","bundleId":"com.example.App","deviceFamily":"ipad","locale":"uk-UA","sdkVersion":"${REACT_NATIVE_SDK_VERSION}"}`,
    );
    expect(links).toMatchObject([{ isDeferred: true, isProbabilisticMatch: true }]);
  });
});

describe('deferred links on other platforms', () => {
  it.each(['web', 'windows', 'macos'])('are disabled on %s', async (os) => {
    Platform.OS = os;
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: asyncStorage(),
      androidPackageName: 'com.example.app',
      iosBundleId: 'com.example.App',
      installReferrerSources: [playReferrer],
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('disabled');
    expect(requests).toEqual([]);
  });
});
