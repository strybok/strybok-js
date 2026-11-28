import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
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
  RouteNotAllowedError,
  type Strybok,
  type StrybokError,
  StrybokNetworkError,
  StrybokRateLimitedError,
  StrybokServerError,
  StrybokTimeoutError,
  StrybokUnauthorizedError,
  StrybokValidationError,
  type CapacitorAppLike,
  type CapacitorHttpLike,
  type CapacitorStrybokOptions,
  type CreatedLink,
  type FetchRequestInit,
  type FetchResponseLike,
  type LinkCampaign,
  type ParameterLinksOptions,
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
  function recorder(answer: Awaited<ReturnType<CapacitorHttpLike['request']>>) {
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

  it('passes request headers through and reads response headers in any case', async () => {
    const { requests, fetch } = recorder({
      status: 429,
      headers: { 'retry-after': '30', 'Content-Type': 'application/json', broken: 7 },
    });
    const response = await fetch('https://api.strybok.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Strybok-Key': 'pk_test' },
      body: '{"routePath":"/a"}',
    });
    expect(requests[0]!.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Strybok-Key': 'pk_test',
    });
    expect(response.headers?.get('Retry-After')).toBe('30');
    expect(response.headers?.get('content-type')).toBe('application/json');
    expect(response.headers?.get('broken')).toBeNull();
    expect(response.headers?.get('X-Missing')).toBeNull();

    for (const headers of [undefined, null]) {
      const bare = await recorder({ status: 429, headers }).fetch('https://api.strybok.com/x', {
        method: 'GET',
        headers: {},
      });
      expect(bare.headers?.get('Retry-After')).toBeNull();
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
        campaign: {},
        isDeferred: false,
        isProbabilisticMatch: false,
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

  describe('links without an API call (parameterLinks)', () => {
    const path = `https://${host}/product/42?id=7&secret=x#top`;
    const long = `https://${host}/?link=https%3A%2F%2Fexample.com%2Fproduct%2F42%3Fid%3D7%26secret%3Dx&apn=com.example.app&ofl=x`;

    beforeEach(() => {
      // Like the native plugin: the answer arrives already parsed.
      state.respond = (request) =>
        request.url.endsWith('/v1/public/events')
          ? { status: 202, data: '' }
          : {
              status: 200,
              data: {
                linkId: 'link_kind',
                appId: 'app_1',
                routePath: '/product/42',
                payload: { id: '7' },
              },
            };
    });

    it('are passed through createStrybok and resolved through native HTTP', async () => {
      expectTypeOf<CapacitorStrybokOptions['parameterLinks']>().toEqualTypeOf<
        ParameterLinksOptions | null | undefined
      >();
      const strybok = create({ parameterLinks: { payloadKeys: ['id'] } });
      expect(strybok.parameterLinks).toEqual({ payloadKeys: ['id'] });
      const received: ResolvedLink[] = [];
      strybok.onLink((link) => received.push(link));
      await strybok.initialize();

      App.open(path);
      App.open(long);
      await settle();
      expect(resolveRequests().map(({ url, method }) => ({ url, method }))).toEqual([
        {
          url: `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(`https://${host}/product/42?id=7`)}`,
          method: 'GET',
        },
        {
          url: `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(
            `https://${host}/?link=https%3A%2F%2Fexample.com%2Fproduct%2F42%3Fid%3D7&apn=com.example.app`,
          )}`,
          method: 'GET',
        },
      ]);
      expect(received.map(({ url, routePath, payload }) => ({ url, routePath, payload }))).toEqual([
        { url: path, routePath: '/product/42', payload: { id: '7' } },
        { url: long, routePath: '/product/42', payload: { id: '7' } },
      ]);
      expect(eventRequests().map((request) => request.data)).toMatchObject([
        { linkId: 'link_kind', type: 'app_open' },
        { linkId: 'link_kind', type: 'app_open' },
      ]);
    });

    it('are ignored without the option, exactly as in 0.3.0', async () => {
      const strybok = create();
      expect(strybok.parameterLinks).toBeNull();
      const received: ResolvedLink[] = [];
      strybok.onLink((link) => received.push(link));
      await strybok.initialize();
      App.open(path);
      App.open(long);
      App.open(`${invite}?id=7&utm_source=mail`);
      await settle();
      expect(resolveRequests().map((request) => request.url)).toEqual([
        `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(`${invite}?utm_source=mail`)}`,
      ]);
      expect(received).toHaveLength(1);
    });

    it('reject an invalid option when the SDK is created', () => {
      expect(() => create({ parameterLinks: { payloadKeys: ['id', 'id'] } })).toThrow(
        /^Strybok: parameterLinks/,
      );
    });
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

  it('sends the campaign query, delivers the campaign and reports it with app_open', async () => {
    // Like the native plugin: the answer arrives already parsed.
    state.respond = (request) => {
      if (request.url.endsWith('/v1/public/events')) return { status: 202, data: '' };
      return {
        status: 200,
        data: {
          linkId: 'link_1',
          appId: 'app_1',
          routePath: '/p/invite777',
          ...(request.url.includes('utm_source') && {
            campaign: { source: 'instagram', medium: 'social' },
          }),
        },
      };
    };
    App.launchUrl = `${invite}?utm_source=instagram&token=secret&utm_medium=two%20words#f`;
    const strybok = create();
    const received: ResolvedLink[] = [];
    strybok.onLink((link) => received.push(link));
    await strybok.initialize();
    App.open(invite);
    await settle();

    const campaigns: LinkCampaign[] = received.map((link) => link.campaign);
    expect(campaigns).toEqual([{ source: 'instagram', medium: 'social' }, {}]);
    expect(received[0]!.url).toBe(App.launchUrl);

    expect(resolveRequests().map((request) => request.url)).toEqual([
      `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(`${invite}?utm_source=instagram`)}`,
      `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(invite)}`,
    ]);
    expect(eventRequests().map((request) => request.data)).toEqual([
      {
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        linkId: 'link_1',
        type: 'app_open',
        platform: 'ios',
        sdkVersion: CAPACITOR_SDK_VERSION,
        campaign: { source: 'instagram', medium: 'social' },
      },
      {
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        linkId: 'link_1',
        type: 'app_open',
        platform: 'ios',
        sdkVersion: CAPACITOR_SDK_VERSION,
      },
    ]);
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

  it('passes clientKey through to createLink', async () => {
    state.respond = () => ({
      status: 201,
      data: { linkId: 'l', slug: 's', routePath: '/a', url: `https://${host}/s` },
    });
    await create({ clientKey: 'pk_from_options' }).createLink('/a');
    expect(state.requests[0]!.headers['X-Strybok-Key']).toBe('pk_from_options');
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

describe('createLink', () => {
  const clientKey = 'pk_0123456789abcdefghijABCDEFGHIJ01';
  const created: CreatedLink = {
    linkId: 'link_9',
    slug: 'aB3xY9',
    routePath: '/product/42',
    url: `https://${host}/aB3xY9`,
  };
  const linkRequests = () => state.requests.filter((r) => r.url.endsWith('/v1/public/links'));

  function sdk(overrides: Partial<Parameters<typeof createStrybok>[0]> = {}): Strybok {
    return create({ clientKey, timeoutMs: 60, retryDelayMs: 1, ...overrides });
  }

  const fail = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('Expected a failure');
      },
      (error: unknown) => error as StrybokError,
    );

  beforeEach(() => {
    // Like the native plugin: JSON responses arrive already parsed.
    state.respond = () => ({ status: 201, data: created });
  });

  it('sends the request through native HTTP with the client key header', async () => {
    const link = await sdk().createLink('/product/42', {
      payload: { productId: 42 },
      title: 'Red shoes',
      description: 'Look at these',
      imageUrl: 'https://cdn.example.com/shoes.png',
    });
    expect(link).toEqual(created);
    // One native request, the same path resolving takes; the plugin gets the JSON as a value.
    expect(state.requests).toEqual([
      {
        url: `${apiBaseUrl}/v1/public/links`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Strybok-Key': clientKey,
        },
        data: {
          routePath: '/product/42',
          payload: { productId: 42 },
          title: 'Red shoes',
          description: 'Look at these',
          imageUrl: 'https://cdn.example.com/shoes.png',
        },
        responseType: 'text',
      },
    ]);
  });

  it('uses native HTTP on Android as well, and never the WebView fetch', async () => {
    state.platform = 'android';
    const originalFetch = globalThis.fetch;
    let webViewCalls = 0;
    globalThis.fetch = (() => {
      webViewCalls++;
      return Promise.resolve(new Response('', { status: 500 }));
    }) as typeof fetch;
    try {
      expect(await sdk().createLink('/product/42')).toEqual(created);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(webViewCalls).toBe(0);
    expect(linkRequests()).toHaveLength(1);
  });

  it('accepts 200 (the link already existed) and a text response', async () => {
    state.respond = () => ({ status: 200, data: JSON.stringify(created) });
    expect(await sdk().createLink('/product/42')).toEqual(created);
  });

  it('omits the arguments that were not given', async () => {
    const strybok = sdk();
    await strybok.createLink('/product/42');
    await strybok.createLink('/product/42', { title: 'Red shoes' });
    expect(state.requests.map((r) => r.data)).toEqual([
      { routePath: '/product/42' },
      { routePath: '/product/42', title: 'Red shoes' },
    ]);
  });

  it('works without initialize and without touching the App plugin', async () => {
    await sdk().createLink('/product/42');
    await settle();
    expect(App.calls).toEqual([]);
  });

  it('is not called when the SDK starts or a link is delivered', async () => {
    App.launchUrl = invite;
    state.respond = (request) =>
      request.url.endsWith('/v1/public/events')
        ? { status: 202, data: '' }
        : { status: 200, data: { linkId: 'l', appId: 'a', routePath: '/p/invite777' } };
    const strybok = sdk();
    const routes: string[] = [];
    strybok.onLink((link) => routes.push(link.routePath));
    await strybok.initialize();
    await settle();
    expect(routes).toEqual(['/p/invite777']);
    expect(linkRequests()).toEqual([]);
    for (const request of state.requests) {
      expect(request.headers['X-Strybok-Key']).toBeUndefined();
    }
  });

  it('fails before any native request without a clientKey or with bad arguments', async () => {
    expect(await fail(sdk({ clientKey: undefined }).createLink('/product/42'))).toBeInstanceOf(
      StrybokUnauthorizedError,
    );
    const strybok = sdk();
    for (const routePath of ['product/42', '//product/42', `/${'a'.repeat(512)}`]) {
      expect(await fail(strybok.createLink(routePath))).toBeInstanceOf(StrybokValidationError);
    }
    expect(
      await fail(strybok.createLink('/product/42', { payload: [1] as unknown as object as never })),
    ).toBeInstanceOf(StrybokValidationError);
    expect(state.requests).toHaveLength(0);
  });

  it('maps the answers of the service to the typed errors', async () => {
    state.respond = () => ({ status: 401, data: { error: { code: 'UNAUTHORIZED' } } });
    expect(await fail(sdk().createLink('/product/42'))).toBeInstanceOf(StrybokUnauthorizedError);

    state.respond = () => ({ status: 403, data: { error: { code: 'ROUTE_NOT_ALLOWED' } } });
    const notAllowed = await fail(sdk().createLink('/admin'));
    expect(notAllowed).toBeInstanceOf(RouteNotAllowedError);
    expect((notAllowed as RouteNotAllowedError).routePath).toBe('/admin');

    // iOS reports header names as sent, Android lower-cases them.
    for (const name of ['Retry-After', 'retry-after']) {
      state.respond = () => ({ status: 429, data: {}, headers: { [name]: '120' } });
      const rateLimited = await fail(sdk().createLink('/product/42'));
      expect(rateLimited).toBeInstanceOf(StrybokRateLimitedError);
      expect((rateLimited as StrybokRateLimitedError).retryAfterSeconds).toBe(120);
    }
    state.respond = () => ({ status: 429 });
    const noHeader = await fail(sdk().createLink('/product/42'));
    expect(noHeader).toBeInstanceOf(StrybokRateLimitedError);
    expect((noHeader as StrybokRateLimitedError).retryAfterSeconds).toBeUndefined();

    for (const status of [400, 413, 422]) {
      state.respond = () => ({
        status,
        data: {
          error: {
            message: 'Request validation failed',
            details: { issues: [{ path: 'title', message: 'Too long' }] },
          },
        },
      });
      const invalid = (await fail(sdk().createLink('/product/42'))) as StrybokValidationError;
      expect(invalid).toBeInstanceOf(StrybokValidationError);
      expect(invalid.statusCode).toBe(status);
      expect(invalid.message).toBe('Request validation failed');
      expect(invalid.issues).toEqual([{ path: 'title', message: 'Too long' }]);
    }

    state.respond = () => ({ status: 404, data: '' });
    const notFound = await fail(sdk().createLink('/product/42'));
    expect(notFound).toBeInstanceOf(StrybokServerError);
    expect((notFound as StrybokServerError).statusCode).toBe(404);

    state.respond = () => ({ status: 201, data: { ...created, url: 'http://insecure.example/x' } });
    const unreadable = await fail(sdk().createLink('/product/42'));
    expect(unreadable).toBeInstanceOf(StrybokServerError);
    expect((unreadable as StrybokServerError).statusCode).toBe(201);

    // None of these is retried: one native request each.
    expect(linkRequests()).toHaveLength(10);
  });

  it('retries 5xx, plugin failures and timeouts with identical data', async () => {
    state.respond = () => ({ status: 503, data: '' });
    const server = await fail(sdk().createLink('/product/42', { payload: { a: 1 } }));
    expect(server).toBeInstanceOf(StrybokServerError);
    expect((server as StrybokServerError).statusCode).toBe(503);
    expect(state.requests).toHaveLength(3);
    expect(state.requests[1]).toEqual(state.requests[0]);
    expect(state.requests[2]).toEqual(state.requests[0]);
    expect(JSON.stringify(state.requests[1]!.data)).toBe(JSON.stringify(state.requests[0]!.data));

    state.requests = [];
    state.respond = () =>
      Promise.reject(new Error('The Internet connection appears to be offline'));
    expect(await fail(sdk().createLink('/product/42'))).toBeInstanceOf(StrybokNetworkError);
    expect(state.requests).toHaveLength(3);

    state.requests = [];
    state.respond = () => new Promise(() => {});
    expect(await fail(sdk({ timeoutMs: 15 }).createLink('/product/42'))).toBeInstanceOf(
      StrybokTimeoutError,
    );
    expect(state.requests).toHaveLength(3);

    state.requests = [];
    state.respond = () =>
      state.requests.length === 1 ? { status: 500 } : { status: 201, data: created };
    expect(await sdk().createLink('/product/42')).toEqual(created);
    expect(state.requests).toHaveLength(2);
  });

  it('keeps the key and the payload out of errors and away from onError', async () => {
    const reported: StrybokError[] = [];
    const secret = 'do-not-leak-this-payload-value';
    const answers: (() => ReturnType<CapacitorHttpLike['request']>)[] = [
      () => Promise.resolve({ status: 401 }),
      () => Promise.resolve({ status: 403 }),
      () => Promise.resolve({ status: 429 }),
      () => Promise.resolve({ status: 422 }),
      () => Promise.resolve({ status: 500 }),
      () => Promise.reject(new Error(`offline ${clientKey} ${secret}`)),
    ];
    for (const respond of answers) {
      state.respond = respond;
      const strybok = sdk({ onError: (error) => reported.push(error) });
      const error = await fail(strybok.createLink('/product/42', { payload: { secret } }));
      const text = `${String(error)} ${JSON.stringify(error)} ${String((error as StrybokNetworkError).cause)}`;
      expect(text).not.toContain(clientKey);
      expect(text).not.toContain(secret);
    }
    await settle();
    expect(reported).toEqual([]);
  });

  it('uses the WebView fetch on the web platform, with the same request', async () => {
    state.platform = 'web';
    const calls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(created), { status: 201 }));
    }) as typeof fetch;
    try {
      expect(await sdk().createLink('/product/42')).toEqual(created);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(state.requests).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${apiBaseUrl}/v1/public/links`);
    expect(calls[0]!.init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Strybok-Key': clientKey,
    });
    expect(calls[0]!.init.body).toBe('{"routePath":"/product/42"}');
  });
});
