// Deferred links through the Capacitor adapter. The flow itself is tested in `@strybok/js`;
// here: the options reach the core, the platform comes from `Capacitor.getPlatform()`, the
// requests go through native HTTP, and nothing happens unless the app passed everything the
// feature needs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITOR_SDK_VERSION,
  createStrybok,
  type DeferredLinkStatus,
  type DeferredLinkStore,
  type InstallReferrerAnswer,
  type PastedLinkResult,
  type ResolvedLink,
  type Strybok,
  type StrybokError,
} from '../src/index.js';
import { App } from './fakes/capacitor-app.js';
import { state } from './fakes/capacitor-core.js';

const host = 'my-app.strybok.link';
const apiBaseUrl = 'https://api.strybok.com';
const invite = `https://${host}/invite777`;
const clickId = `dc_${'aB3x'.repeat(8)}`;
const pasted = `${invite}?strybok_click=${clickId}`;
const redeemUrl = `${apiBaseUrl}/v1/public/deferred-links/redeem`;
const matchUrl = `${apiBaseUrl}/v1/public/deferred-links/match`;

const instances: Strybok[] = [];
let errors: StrybokError[] = [];

/**
 * What an app writes around `@capacitor/preferences` (a separate plugin, not a dependency of
 * this package): `get({ key })` answers `{ value }`, `set({ key, value })` stores.
 */
function preferencesStore(): DeferredLinkStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  const Preferences = {
    get: ({ key }: { key: string }) => Promise.resolve({ value: data.get(key) ?? null }),
    set: ({ key, value }: { key: string; value: string }) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
  return {
    data,
    getItem: async (key) => (await Preferences.get({ key })).value,
    setItem: (key, value) => Preferences.set({ key, value }),
  };
}

function create(overrides: Partial<Parameters<typeof createStrybok>[0]> = {}): Strybok {
  const strybok = createStrybok({
    apiBaseUrl,
    allowedHosts: [host],
    onError: (error) => errors.push(error),
    ...overrides,
  });
  instances.push(strybok);
  return strybok;
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(strybok: Strybok, status: DeferredLinkStatus): Promise<void> {
  await vi.waitFor(() => expect(strybok.deferredLinkStatus).toBe(status), { interval: 5 });
}

const playReferrer = (): Promise<InstallReferrerAnswer> =>
  Promise.resolve({ status: 'referrer', referrer: `strybok_click=${clickId}&utm_source=google` });

beforeEach(() => {
  App.reset();
  state.platform = 'android';
  state.requests = [];
  errors = [];
  // Like the native plugin: JSON responses arrive already parsed.
  state.respond = (request) => {
    if (request.url.endsWith('/v1/public/events')) return { status: 202, data: '' };
    const link = { linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' };
    if (request.url === redeemUrl) {
      return { status: 200, data: { ...link, url: invite, deferred: true } };
    }
    if (request.url === matchUrl) {
      return {
        status: 200,
        data: { ...link, url: invite, deferred: true, matched: 'probabilistic' },
      };
    }
    return { status: 200, data: link };
  };
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

describe('deferred links on Android', () => {
  it('are off by default: no source is asked and no request is made', async () => {
    const source = vi.fn(playReferrer);
    const store = preferencesStore();
    const strybok = create({
      deferredLinkStore: store,
      androidPackageName: 'com.example.app',
      installReferrerSources: [source],
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(source).not.toHaveBeenCalled();
    expect(state.requests).toEqual([]);
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
    expect(state.requests).toEqual([]);
  });

  it('stay disabled without the package name', async () => {
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: preferencesStore(),
      installReferrerSources: [playReferrer],
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(state.requests).toEqual([]);
  });

  it('redeem the click id through native HTTP and deliver the link', async () => {
    const store = preferencesStore();
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

    expect(state.requests).toEqual([
      {
        url: redeemUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // The plugin serialises JSON itself: it gets the value, with exactly these fields.
        data: {
          platform: 'android',
          clickId,
          packageName: 'com.example.app',
          sdkVersion: CAPACITOR_SDK_VERSION,
        },
        responseType: 'text',
      },
    ]);
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
    expect(state.requests).toHaveLength(1); // No app_open.
    expect(errors).toEqual([]);
  });

  it('are dropped when a link opened the app', async () => {
    App.launchUrl = invite;
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: preferencesStore(),
      androidPackageName: 'com.example.app',
      installReferrerSources: [playReferrer],
      reportAppOpens: false,
    });
    await strybok.initialize();
    await until(strybok, 'superseded');
    expect(state.requests.filter((request) => request.url === redeemUrl)).toEqual([]);
  });

  it('can be switched on after a consent screen', async () => {
    const strybok = create({
      deferredLinkStore: preferencesStore(),
      androidPackageName: 'com.example.app',
      installReferrerSources: [playReferrer],
    });
    await strybok.initialize();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    strybok.enableDeferredLinks();
    await until(strybok, 'delivered');
  });
});

describe('deferred links on iOS', () => {
  beforeEach(() => {
    state.platform = 'ios';
  });

  it('never ask an install referrer source', async () => {
    const source = vi.fn(playReferrer);
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: preferencesStore(),
      iosBundleId: 'com.example.App',
      installReferrerSources: [source],
    });
    await strybok.initialize();
    await until(strybok, 'unavailable');
    expect(source).not.toHaveBeenCalled();
    expect(state.requests).toEqual([]);
  });

  it('redeem the link the person pasted', async () => {
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: preferencesStore(),
      iosBundleId: 'com.example.App',
    });
    const links: ResolvedLink[] = [];
    strybok.onLink((link) => links.push(link));
    await strybok.initialize();

    expect(await strybok.redeemPastedLink('some other text')).toBe<PastedLinkResult>('notOurs');
    expect(state.requests).toEqual([]);
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('delivered');
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({
      url: redeemUrl,
      data: {
        platform: 'ios',
        clickId,
        bundleId: 'com.example.App',
        sdkVersion: CAPACITOR_SDK_VERSION,
      },
    });
    expect(Object.keys(state.requests[0]?.data as object)).toHaveLength(4);
    expect(links).toMatchObject([{ url: invite, isDeferred: true, isProbabilisticMatch: false }]);
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('alreadyHandled');
  });

  it('match only with allowProbabilisticMatching, from the callbacks of the app', async () => {
    const options = {
      deferredLinks: true,
      iosBundleId: 'com.example.App',
      deviceFamily: () => 'iphone',
      locale: () => 'en-GB',
    };
    const without = create({ ...options, deferredLinkStore: preferencesStore() });
    await without.initialize();
    await until(without, 'unavailable');
    expect(state.requests).toEqual([]);

    const strybok = create({
      ...options,
      deferredLinkStore: preferencesStore(),
      allowProbabilisticMatching: true,
    });
    const links: ResolvedLink[] = [];
    strybok.onLink((link) => links.push(link));
    await strybok.initialize();
    await until(strybok, 'delivered');
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.url).toBe(matchUrl);
    expect(state.requests[0]?.data).toEqual({
      platform: 'ios',
      bundleId: 'com.example.App',
      deviceFamily: 'iphone',
      locale: 'en-GB',
      sdkVersion: CAPACITOR_SDK_VERSION,
    });
    expect(links).toMatchObject([{ isDeferred: true, isProbabilisticMatch: true }]);
  });
});

describe('deferred links in the browser', () => {
  it('are disabled on the web platform', async () => {
    state.platform = 'web';
    const strybok = create({
      deferredLinks: true,
      deferredLinkStore: preferencesStore(),
      androidPackageName: 'com.example.app',
      iosBundleId: 'com.example.App',
      installReferrerSources: [playReferrer],
      fetch: () => Promise.reject(new Error('no request expected')),
    });
    await strybok.initialize();
    await settle();
    expect(strybok.deferredLinkStatus).toBe('disabled');
    expect(await strybok.redeemPastedLink(pasted)).toBe<PastedLinkResult>('disabled');
    expect(state.requests).toEqual([]);
  });
});
