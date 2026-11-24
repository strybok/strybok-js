import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import corePackageJson from '../../js_sdk/package.json' with { type: 'json' };
import {
  CAPACITOR_SDK_VERSION,
  capacitorHttpFetch,
  capacitorLinkSource,
  createCapacitorHttpFetch,
  createCapacitorLinkSource,
  createStrybok,
  LinkNotFoundError,
  type Strybok,
  StrybokNetworkError,
  type CapacitorAppLike,
  type CapacitorHttpLike,
  type FetchRequestInit,
  type FetchResponseLike,
  type ResolvedLink,
} from '../src/index.js';
import { createStrybokWith } from '../src/factory.js';
import { toStrybokPlatform } from '../src/platform.js';
import { FakeLinkSource } from '../src/testing.js';
import { App } from './fakes/capacitor-app.js';
import { state } from './fakes/capacitor-core.js';

const host = 'my-app.strybok.link';
const apiBaseUrl = 'https://api.strybok.com';
const invite = `https://${host}/invite777`;

const instances: Strybok[] = [];

function create(overrides: Partial<Parameters<typeof createStrybok>[0]> = {}): Strybok {
  const strybok = createStrybok({ apiBaseUrl, allowedHosts: [host], ...overrides });
  instances.push(strybok);
  return strybok;
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const eventRequests = () => state.requests.filter((r) => r.url.endsWith('/v1/public/events'));
const resolveRequests = () => state.requests.filter((r) => r.url.includes('/v1/public/resolve'));

beforeEach(() => {
  App.reset();
  state.platform = 'ios';
  state.requests = [];
  // Like the native plugin: JSON responses arrive already parsed.
  state.respond = (request) => {
    if (request.url.endsWith('/v1/public/events')) return { status: 202, data: '' };
    const slug = decodeURIComponent(request.url).split('/').pop() as string;
    return {
      status: 200,
      data: { linkId: `link_${slug}`, appId: 'app_1', routePath: `/p/${slug}`, payload: { slug } },
    };
  };
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

describe('createCapacitorLinkSource', () => {
  it('reads the launch URL from App.getLaunchUrl', async () => {
    const source = createCapacitorLinkSource(App);
    expect(await source.getInitialUrl()).toBeNull();
    App.launchUrl = '';
    expect(await source.getInitialUrl()).toBeNull();
    App.launchUrl = invite;
    expect(await source.getInitialUrl()).toBe(invite);
  });

  it('forwards appUrlOpen events and removes the listener', async () => {
    const source = createCapacitorLinkSource(App);
    const received: string[] = [];
    const unsubscribe = source.subscribe((url) => received.push(url));
    // Registered synchronously, before anything else can be asked of the plugin.
    expect(App.calls).toEqual(['addListener:appUrlOpen']);

    App.open(invite);
    expect(received).toEqual([invite]);

    unsubscribe();
    unsubscribe(); // idempotent
    App.open(invite); // Dropped at once, even though removal is asynchronous.
    await settle();
    expect(received).toEqual([invite]);
    expect(App.calls).toEqual(['addListener:appUrlOpen', 'remove']);
    expect(App.listeners.size).toBe(0);
  });

  it('accepts a handle returned directly (Capacitor 4) and malformed events', async () => {
    let removed = 0;
    let emit!: (event: { url: string }) => void;
    const app: CapacitorAppLike = {
      getLaunchUrl: () => Promise.resolve(null),
      addListener: (_eventName, listener) => {
        emit = listener;
        return { remove: () => void removed++ };
      },
    };
    const received: string[] = [];
    const unsubscribe = createCapacitorLinkSource(app).subscribe((url) => received.push(url));
    emit(undefined as unknown as { url: string });
    emit({} as { url: string });
    emit({ url: invite });
    expect(received).toEqual([invite]);
    unsubscribe();
    await settle();
    expect(removed).toBe(1);
  });

  it('has no stream when the plugin cannot register a listener', async () => {
    for (const addListener of [
      () => {
        throw new Error('not implemented');
      },
      () => Promise.reject(new Error('not implemented')),
    ]) {
      const app: CapacitorAppLike = { getLaunchUrl: () => Promise.resolve(undefined), addListener };
      const unsubscribe = createCapacitorLinkSource(app).subscribe(() => {});
      await settle();
      unsubscribe();
      await settle();
    }
  });

  it('capacitorLinkSource wraps the App plugin', async () => {
    App.launchUrl = invite;
    expect(await capacitorLinkSource().getInitialUrl()).toBe(invite);
  });
});

describe('createCapacitorHttpFetch', () => {
  function recorder(answer: { status: number; data?: unknown }) {
    const requests: Parameters<CapacitorHttpLike['request']>[0][] = [];
    const http: CapacitorHttpLike = {
      request: (options) => {
        requests.push(options);
        return Promise.resolve(answer);
      },
    };
    return { requests, fetch: createCapacitorHttpFetch(http) };
  }

  it('sends a GET without a body', async () => {
    const { requests, fetch } = recorder({ status: 200, data: '{"a":1}' });
    const init: FetchRequestInit = { method: 'GET', headers: { Accept: 'application/json' } };
    const response = await fetch('https://api.strybok.com/x', init);
    expect(requests).toEqual([
      {
        url: 'https://api.strybok.com/x',
        method: 'GET',
        headers: { Accept: 'application/json' },
        responseType: 'text',
      },
    ]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"a":1}');
  });

  it('hands JSON bodies to the plugin as values and other bodies as text', async () => {
    const { requests, fetch } = recorder({ status: 202 });
    await fetch('https://api.strybok.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"app_open"}',
    });
    await fetch('https://api.strybok.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"type":"app_open"}',
    });
    expect(requests[0]!.data).toEqual({ type: 'app_open' });
    expect(requests[1]!.data).toBe('{"type":"app_open"}');
  });

  it('turns already-parsed response data back into text', async () => {
    const cases: [unknown, string][] = [
      [{ linkId: 'l' }, '{"linkId":"l"}'],
      [[1, 2], '[1,2]'],
      ['plain', 'plain'],
      [undefined, ''],
      [null, ''],
      [7, '7'],
    ];
    for (const [data, text] of cases) {
      const { fetch } = recorder({ status: 200, data });
      const response = await fetch('https://api.strybok.com/x', { method: 'GET', headers: {} });
      expect(await response.text()).toBe(text);
    }
  });

  it('rejects when the plugin fails or answers with nothing usable', async () => {
    const failing: CapacitorHttpLike = { request: () => Promise.reject(new Error('offline')) };
    await expect(
      createCapacitorHttpFetch(failing)('https://api.strybok.com/x', {
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow('offline');
    const { fetch } = recorder(undefined as unknown as { status: number });
    await expect(
      fetch('https://api.strybok.com/x', { method: 'GET', headers: {} }),
    ).rejects.toThrow(TypeError);
  });

  it('capacitorHttpFetch wraps the CapacitorHttp plugin', async () => {
    const fetch = capacitorHttpFetch();
    expect(fetch).toBeTypeOf('function');
    const response = await fetch!(`${apiBaseUrl}/v1/public/events`, {
      method: 'POST',
      headers: {},
    });
    expect(response.status).toBe(202);
  });
});

describe('toStrybokPlatform', () => {
  it('maps Capacitor.getPlatform()', () => {
    expect(toStrybokPlatform('ios')).toBe('ios');
    expect(toStrybokPlatform('android')).toBe('android');
    for (const platform of ['web', 'electron', '', undefined, null]) {
      expect(toStrybokPlatform(platform)).toBe('unknown');
    }
  });
});

describe('createStrybok', () => {
  it('delivers the cold-start link exactly once, through native HTTP', async () => {
    App.launchUrl = invite;
    const strybok = create();
    await strybok.initialize();
    // Listening before asking for the launch URL.
    expect(App.calls).toEqual(['addListener:appUrlOpen', 'getLaunchUrl']);

    const received: ResolvedLink[] = [];
    strybok.onLink((link) => received.push(link));
    await settle();
    expect(received).toEqual([
      {
        url: invite,
        linkId: 'link_invite777',
        appId: 'app_1',
        routePath: '/p/invite777',
        payload: { slug: 'invite777' },
      },
    ]);
    expect(resolveRequests()).toHaveLength(1);
    expect(resolveRequests()[0]).toMatchObject({
      url: `${apiBaseUrl}/v1/public/resolve?url=https%3A%2F%2F${host}%2Finvite777`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('de-duplicates the launch URL that the plugin retained for the first listener', async () => {
    App.launchUrl = invite;
    App.retained = invite;
    const strybok = create();
    // Only getInitialLink is used: the retained event must not hide the launch link from it.
    const initial = await strybok.getInitialLink();
    expect(initial?.routePath).toBe('/p/invite777');
    await settle();
    expect(resolveRequests()).toHaveLength(1);
    expect(eventRequests()).toHaveLength(1);

    const received: ResolvedLink[] = [];
    strybok.onLink((link) => received.push(link));
    await settle();
    expect(received).toHaveLength(0);
  });

  it('delivers the launch link when only the retained event reports it', async () => {
    App.retained = invite; // getLaunchUrl() has nothing
    const strybok = create();
    const received: ResolvedLink[] = [];
    strybok.onLink((link) => received.push(link));
    await strybok.initialize();
    await settle();
    expect(received).toHaveLength(1);
  });

  it('delivers links received while running and ignores foreign URLs', async () => {
    const strybok = create();
    const received: string[] = [];
    strybok.onLink((link) => received.push(link.routePath));
    await strybok.initialize();

    App.open(`https://${host}/first`);
    App.open('myapp://settings');
    App.open('https://evil.example.com/second');
    await settle();
    expect(received).toEqual(['/p/first']);
    expect(resolveRequests()).toHaveLength(1);
  });

  it('sends the app_open event as a JSON value with platform and adapter version', async () => {
    expect(CAPACITOR_SDK_VERSION).toBe(`${corePackageJson.version}+capacitor`);
    expect(packageJson.version).toBe(corePackageJson.version);
    expect(CAPACITOR_SDK_VERSION).toMatch(/^[0-9A-Za-z.+-]{1,32}$/);

    for (const platform of ['ios', 'android'] as const) {
      App.reset();
      state.requests = [];
      state.platform = platform;
      App.launchUrl = invite;
      const strybok = create();
      expect(strybok.platform).toBe(platform);
      await strybok.initialize();
      await settle();
      expect(eventRequests()).toHaveLength(1);
      const request = eventRequests()[0]!;
      expect(request.method).toBe('POST');
      expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(request.data).toEqual({
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        linkId: 'link_invite777',
        type: 'app_open',
        platform,
        sdkVersion: CAPACITOR_SDK_VERSION,
      });
    }
  });

  it('maps HTTP statuses and plugin failures to the typed errors', async () => {
    state.respond = () => ({ status: 404, data: { error: { code: 'LINK_NOT_FOUND' } } });
    await expect(create().resolveUrl(invite)).rejects.toBeInstanceOf(LinkNotFoundError);

    state.respond = () =>
      Promise.reject(new Error('The Internet connection appears to be offline'));
    await expect(
      create({ maxRetries: 1, retryDelayMs: 1 }).resolveUrl(invite),
    ).rejects.toBeInstanceOf(StrybokNetworkError);
  });

  it('uses the WebView fetch on the web platform, where there is no native HTTP', async () => {
    state.platform = 'web';
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response('', { status: 404 }));
    }) as typeof fetch;
    try {
      const strybok = create();
      expect(strybok.platform).toBe('unknown');
      await expect(strybok.resolveUrl(invite)).rejects.toBeInstanceOf(LinkNotFoundError);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls).toHaveLength(1);
    expect(state.requests).toHaveLength(0);
  });

  it('falls back to fetch when @capacitor/core has no CapacitorHttp', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('', { status: 404 }));
    }) as typeof fetch;
    try {
      const strybok = createStrybokWith(
        { App, Capacitor: { getPlatform: () => 'android' }, CapacitorHttp: undefined },
        { apiBaseUrl, allowedHosts: [host] },
      );
      instances.push(strybok);
      await expect(strybok.resolveUrl(invite)).rejects.toBeInstanceOf(LinkNotFoundError);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(1);
  });

  it('lets the app replace the transport, the link source and the platform', async () => {
    const calls: string[] = [];
    const fetch = (url: string): Promise<FetchResponseLike> => {
      calls.push(url);
      return Promise.resolve({ status: 404, text: () => Promise.resolve('') });
    };
    const source = new FakeLinkSource({ initialUrl: invite });
    const strybok = create({ fetch, linkSource: source, platform: 'android' });
    expect(strybok.platform).toBe('android');
    await strybok.initialize();
    expect(calls).toHaveLength(1);
    expect(state.requests).toHaveLength(0);
    expect(App.calls).toEqual([]);
  });

  it('dispose removes the plugin listener', async () => {
    const strybok = create();
    await strybok.initialize();
    expect(App.listeners.size).toBe(1);
    strybok.dispose();
    await settle();
    expect(App.listeners.size).toBe(0);
  });
});
