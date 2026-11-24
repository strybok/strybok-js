import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import corePackageJson from '../../js_sdk/package.json' with { type: 'json' };
import {
  createLinkingSource,
  createStrybok,
  LinkNotFoundError,
  REACT_NATIVE_SDK_VERSION,
  reactNativeLinkSource,
  RouteNotAllowedError,
  Strybok,
  StrybokError,
  StrybokNetworkError,
  StrybokRateLimitedError,
  StrybokServerError,
  StrybokTimeoutError,
  StrybokUnauthorizedError,
  StrybokValidationError,
  useStrybokLink,
  type CreatedLink,
  type FetchRequestInit,
  type FetchResponseLike,
  type LinkingLike,
  type ResolvedLink,
} from '../src/index.js';
import { toStrybokPlatform } from '../src/platform.js';
import { FakeLinkSource } from '../src/testing.js';
import { Linking, Platform } from './fakes/react-native.js';
import { render } from './fakes/react.js';
import { apiBaseUrl, fakeApi, host, invite, settle } from './helpers.js';

const instances: Strybok[] = [];

function create(overrides: Partial<Parameters<typeof createStrybok>[0]> = {}) {
  const api = fakeApi();
  const strybok = createStrybok({
    apiBaseUrl,
    allowedHosts: [host],
    fetch: api.fetch,
    ...overrides,
  });
  instances.push(strybok);
  return { api, strybok };
}

beforeEach(() => {
  Linking.reset();
  Platform.OS = 'ios';
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

describe('createLinkingSource', () => {
  it('reads the launch URL from Linking.getInitialURL', async () => {
    const source = createLinkingSource(Linking);
    expect(await source.getInitialUrl()).toBeNull();
    Linking.initialUrl = invite;
    expect(await source.getInitialUrl()).toBe(invite);
  });

  it('forwards url events and removes the subscription', () => {
    const source = createLinkingSource(Linking);
    const received: string[] = [];
    const unsubscribe = source.subscribe((url) => received.push(url));
    expect(Linking.calls).toEqual(['addEventListener:url']);

    Linking.open(invite);
    expect(received).toEqual([invite]);

    unsubscribe();
    unsubscribe(); // idempotent
    expect(Linking.calls).toEqual(['addEventListener:url', 'remove']);
    Linking.open(invite);
    expect(received).toEqual([invite]);
  });

  it('ignores malformed events', () => {
    const source = createLinkingSource(Linking);
    const received: string[] = [];
    source.subscribe((url) => received.push(url));
    for (const handler of Linking.handlers) {
      handler(undefined as unknown as { url: string });
      handler({} as { url: string });
      handler({ url: 42 } as unknown as { url: string });
    }
    expect(received).toEqual([]);
  });

  it('falls back to removeEventListener on React Native < 0.65', () => {
    const removed: unknown[] = [];
    let registered: unknown;
    const legacy: LinkingLike = {
      getInitialURL: () => Promise.resolve(null),
      addEventListener(_type, handler) {
        registered = handler;
      },
      removeEventListener(_type, handler) {
        removed.push(handler);
      },
    };
    const unsubscribe = createLinkingSource(legacy).subscribe(() => {});
    unsubscribe();
    expect(removed).toEqual([registered]);
  });

  it('reactNativeLinkSource wraps the Linking module', async () => {
    Linking.initialUrl = invite;
    expect(await reactNativeLinkSource().getInitialUrl()).toBe(invite);
  });
});

describe('toStrybokPlatform', () => {
  it('maps Platform.OS', () => {
    expect(toStrybokPlatform('ios')).toBe('ios');
    expect(toStrybokPlatform('android')).toBe('android');
    for (const os of ['web', 'windows', 'macos', 'IOS', '', undefined, null]) {
      expect(toStrybokPlatform(os)).toBe('unknown');
    }
  });
});

describe('createStrybok', () => {
  it('delivers the cold-start link from Linking.getInitialURL exactly once', async () => {
    Linking.initialUrl = invite;
    const { api, strybok } = create();
    await strybok.initialize();
    // Subscribed to the stream before asking for the launch URL.
    expect(Linking.calls).toEqual(['addEventListener:url', 'getInitialURL']);

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
    expect(api.resolves).toHaveLength(1);
    expect(await strybok.getInitialLink()).toBeNull();
  });

  it('delivers links received while running and ignores foreign URLs', async () => {
    const { api, strybok } = create();
    const received: string[] = [];
    strybok.onLink((link) => received.push(link.routePath));
    await strybok.initialize();

    Linking.open(`https://${host}/first`);
    Linking.open('myapp://settings');
    Linking.open('https://evil.example.com/second');
    Linking.open(`exp://127.0.0.1:8081/--/${host}/third`);
    await settle();
    expect(received).toEqual(['/p/first']);
    expect(api.resolves).toHaveLength(1);
  });

  it('drops a launch URL that Linking also reports as a url event', async () => {
    Linking.initialUrl = invite;
    const { api, strybok } = create();
    const received: ResolvedLink[] = [];
    strybok.onLink((link) => received.push(link));
    const initialized = strybok.initialize();
    Linking.open(invite);
    await initialized;
    await settle();
    expect(received).toHaveLength(1);
    expect(api.resolves).toHaveLength(1);
    expect(api.events).toHaveLength(1);
  });

  it('reports the platform from Platform.OS and the adapter version', async () => {
    expect(REACT_NATIVE_SDK_VERSION).toBe(`${corePackageJson.version}+react-native`);
    expect(packageJson.version).toBe(corePackageJson.version);
    expect(REACT_NATIVE_SDK_VERSION).toMatch(/^[0-9A-Za-z.+-]{1,32}$/);

    for (const [os, platform] of [
      ['ios', 'ios'],
      ['android', 'android'],
      ['web', 'unknown'],
    ] as const) {
      Linking.reset();
      Linking.initialUrl = invite;
      Platform.OS = os;
      const { api, strybok } = create();
      expect(strybok.platform).toBe(platform);
      await strybok.initialize();
      await settle();
      expect(api.events).toHaveLength(1);
      expect(api.events[0]).toMatchObject({
        type: 'app_open',
        linkId: 'link_invite777',
        platform,
        sdkVersion: REACT_NATIVE_SDK_VERSION,
      });
    }
  });

  it('lets tests replace the link source and the platform', async () => {
    const source = new FakeLinkSource({ initialUrl: invite });
    const { strybok } = create({ linkSource: source, platform: 'android' });
    expect(strybok.platform).toBe('android');
    expect((await strybok.getInitialLink())?.routePath).toBe('/p/invite777');
    expect(Linking.calls).toEqual([]);
  });

  it('dispose removes the Linking subscription', async () => {
    const { strybok } = create();
    await strybok.initialize();
    expect(Linking.handlers.size).toBe(1);
    strybok.dispose();
    expect(Linking.handlers.size).toBe(0);
  });

  it('re-exports the core API', async () => {
    const { strybok } = create({
      fetch: () => Promise.resolve({ status: 404, text: () => Promise.resolve('') }),
    });
    expect(strybok).toBeInstanceOf(Strybok);
    const error = await strybok.resolveUrl(invite).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkNotFoundError);
    expect(error).toBeInstanceOf(StrybokError);
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

  function answer(
    status: number,
    body: unknown = '',
    headers?: Record<string, string>,
  ): FetchResponseLike {
    return {
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      ...(headers ? { headers: new Headers(headers) } : {}),
    };
  }

  /** A `createStrybok` instance whose transport records requests and answers with `respond`. */
  function setup(
    respond: (attempt: number) => FetchResponseLike | Promise<FetchResponseLike> = () =>
      answer(201, created),
    overrides: Partial<Parameters<typeof createStrybok>[0]> = {},
  ) {
    const calls: { url: string; init: FetchRequestInit }[] = [];
    const { strybok } = create({
      clientKey,
      timeoutMs: 60,
      retryDelayMs: 1,
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve().then(() => respond(calls.length));
      },
      ...overrides,
    });
    return { calls, strybok };
  }

  const fail = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('Expected a failure');
      },
      (error: unknown) => error as StrybokError,
    );

  it('passes clientKey from createStrybok and returns the created link', async () => {
    const { calls, strybok } = setup();
    const link = await strybok.createLink('/product/42', {
      payload: { productId: 42 },
      title: 'Red shoes',
      description: 'Look at these',
      imageUrl: 'https://cdn.example.com/shoes.png',
    });
    expect(link).toEqual(created);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${apiBaseUrl}/v1/public/links`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Strybok-Key': clientKey,
    });
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      routePath: '/product/42',
      payload: { productId: 42 },
      title: 'Red shoes',
      description: 'Look at these',
      imageUrl: 'https://cdn.example.com/shoes.png',
    });
  });

  it('accepts 200 (the link already existed) and omits what was not given', async () => {
    const { calls, strybok } = setup(() => answer(200, created));
    expect(await strybok.createLink('/product/42')).toEqual(created);
    expect(calls[0]!.init.body).toBe('{"routePath":"/product/42"}');
  });

  it('works without initialize and without touching Linking', async () => {
    const { strybok } = setup();
    await strybok.createLink('/product/42');
    await settle();
    expect(Linking.calls).toEqual([]);
  });

  it('is not called when the SDK starts or a link is delivered', async () => {
    Linking.initialUrl = invite;
    const api = fakeApi();
    const { strybok } = create({ clientKey, fetch: api.fetch });
    const routes: string[] = [];
    strybok.onLink((link) => routes.push(link.routePath));
    await strybok.initialize();
    await settle();
    expect(routes).toEqual(['/p/invite777']);
    expect(api.resolves.filter((url) => url.includes('/v1/public/links'))).toEqual([]);
  });

  it('fails before any network call without a clientKey or with bad arguments', async () => {
    const without = setup(undefined, { clientKey: undefined });
    expect(await fail(without.strybok.createLink('/product/42'))).toBeInstanceOf(
      StrybokUnauthorizedError,
    );
    expect(without.calls).toHaveLength(0);

    const { calls, strybok } = setup();
    for (const routePath of ['product/42', '//product/42', `/${'a'.repeat(512)}`]) {
      expect(await fail(strybok.createLink(routePath))).toBeInstanceOf(StrybokValidationError);
    }
    expect(
      await fail(strybok.createLink('/product/42', { payload: [1] as unknown as object as never })),
    ).toBeInstanceOf(StrybokValidationError);
    expect(calls).toHaveLength(0);
  });

  it('maps the answers of the service to the typed errors', async () => {
    const unauthorized = setup(() => answer(401));
    expect(await fail(unauthorized.strybok.createLink('/product/42'))).toBeInstanceOf(
      StrybokUnauthorizedError,
    );
    expect(unauthorized.calls).toHaveLength(1);

    const forbidden = setup(() => answer(403));
    const notAllowed = await fail(forbidden.strybok.createLink('/admin'));
    expect(notAllowed).toBeInstanceOf(RouteNotAllowedError);
    expect((notAllowed as RouteNotAllowedError).routePath).toBe('/admin');
    expect(forbidden.calls).toHaveLength(1);

    const limited = setup(() => answer(429, '', { 'Retry-After': '120' }));
    const rateLimited = await fail(limited.strybok.createLink('/product/42'));
    expect(rateLimited).toBeInstanceOf(StrybokRateLimitedError);
    expect((rateLimited as StrybokRateLimitedError).retryAfterSeconds).toBe(120);
    expect(limited.calls).toHaveLength(1);

    const noHeader = setup(() => answer(429));
    expect(
      ((await fail(noHeader.strybok.createLink('/product/42'))) as StrybokRateLimitedError)
        .retryAfterSeconds,
    ).toBeUndefined();

    for (const status of [400, 413, 422]) {
      const rejected = setup(() =>
        answer(status, {
          error: {
            message: 'Request validation failed',
            details: { issues: [{ path: 'title', message: 'Too long' }] },
          },
        }),
      );
      const invalid = (await fail(
        rejected.strybok.createLink('/product/42'),
      )) as StrybokValidationError;
      expect(invalid).toBeInstanceOf(StrybokValidationError);
      expect(invalid.statusCode).toBe(status);
      expect(invalid.message).toBe('Request validation failed');
      expect(invalid.issues).toEqual([{ path: 'title', message: 'Too long' }]);
      expect(rejected.calls).toHaveLength(1);
    }

    const other = setup(() => answer(404));
    const notFound = await fail(other.strybok.createLink('/product/42'));
    expect(notFound).toBeInstanceOf(StrybokServerError);
    expect((notFound as StrybokServerError).statusCode).toBe(404);
    expect(other.calls).toHaveLength(1);

    const malformed = setup(() => answer(201, { ...created, url: 'http://insecure.example/x' }));
    const unreadable = await fail(malformed.strybok.createLink('/product/42'));
    expect(unreadable).toBeInstanceOf(StrybokServerError);
    expect((unreadable as StrybokServerError).statusCode).toBe(201);
    expect(malformed.calls).toHaveLength(1);
  });

  it('retries 5xx, network failures and timeouts with an identical body', async () => {
    const down = setup(() => answer(503));
    const server = await fail(down.strybok.createLink('/product/42', { payload: { a: 1 } }));
    expect(server).toBeInstanceOf(StrybokServerError);
    expect((server as StrybokServerError).statusCode).toBe(503);
    expect(down.calls).toHaveLength(3);
    expect(new Set(down.calls.map((call) => call.init.body)).size).toBe(1);

    const offline = setup(() => Promise.reject(new TypeError('Network request failed')));
    expect(await fail(offline.strybok.createLink('/product/42'))).toBeInstanceOf(
      StrybokNetworkError,
    );
    expect(offline.calls).toHaveLength(3);

    const silent = setup(() => new Promise<FetchResponseLike>(() => {}), { timeoutMs: 15 });
    expect(await fail(silent.strybok.createLink('/product/42'))).toBeInstanceOf(
      StrybokTimeoutError,
    );
    expect(silent.calls).toHaveLength(3);

    const recovering = setup((attempt) => (attempt === 1 ? answer(500) : answer(201, created)));
    expect(await recovering.strybok.createLink('/product/42')).toEqual(created);
    expect(recovering.calls).toHaveLength(2);
  });

  it('keeps the key and the payload out of errors and away from onError', async () => {
    const reported: StrybokError[] = [];
    const secret = 'do-not-leak-this-payload-value';
    for (const respond of [
      () => answer(401),
      () => answer(403),
      () => answer(429),
      () => answer(422),
      () => answer(500),
      () => Promise.reject(new Error('offline')),
    ]) {
      const { strybok } = setup(respond, { onError: (error) => reported.push(error) });
      const error = await fail(strybok.createLink('/product/42', { payload: { secret } }));
      const text = `${String(error)} ${JSON.stringify(error)} ${String((error as StrybokNetworkError).cause)}`;
      expect(text).not.toContain(clientKey);
      expect(text).not.toContain(secret);
    }
    await settle();
    expect(reported).toEqual([]);
  });
});

describe('useStrybokLink', () => {
  it('starts the SDK and delivers the cold-start link to the component', async () => {
    Linking.initialUrl = invite;
    const { strybok } = create();
    const received: string[] = [];
    const view = render(() => useStrybokLink(strybok, (link) => received.push(link.routePath)), {});
    await settle();
    expect(received).toEqual(['/p/invite777']);

    Linking.open(`https://${host}/next`);
    await settle();
    expect(received).toEqual(['/p/invite777', '/p/next']);
    view.unmount();
  });

  it('calls the latest callback without re-subscribing', async () => {
    const { strybok } = create();
    let subscriptions = 0;
    const counting = {
      initialize: () => strybok.initialize(),
      onLink: (listener: (link: ResolvedLink) => void) => {
        subscriptions++;
        return strybok.onLink(listener);
      },
    };
    const received: string[] = [];
    const view = render(
      ({ tag }: { tag: string }) =>
        useStrybokLink(counting, (link) => received.push(`${tag}:${link.routePath}`)),
      { tag: 'a' },
    );
    await settle();
    view.rerender({ tag: 'b' });
    view.rerender({ tag: 'c' });
    Linking.open(invite);
    await settle();
    expect(received).toEqual(['c:/p/invite777']);
    expect(subscriptions).toBe(1);
    view.unmount();
  });

  it('stops delivering after unmount and queues for the next mount', async () => {
    const { strybok } = create();
    const first: string[] = [];
    const view = render(() => useStrybokLink(strybok, (link) => first.push(link.routePath)), {});
    await settle();
    view.unmount();

    Linking.open(invite);
    await settle();
    expect(first).toEqual([]);

    const second: string[] = [];
    const next = render(() => useStrybokLink(strybok, (link) => second.push(link.routePath)), {});
    await settle();
    expect(second).toEqual(['/p/invite777']);
    next.unmount();
  });

  it('survives a double-invoked effect (React StrictMode) without losing the launch link', async () => {
    Linking.initialUrl = invite;
    const { api, strybok } = create();
    await strybok.initialize();
    const received: string[] = [];
    const component = () => useStrybokLink(strybok, (link) => received.push(link.routePath));
    render(component, {}).unmount(); // mount + immediate cleanup
    const view = render(component, {});
    await settle();
    expect(received).toEqual(['/p/invite777']);
    expect(api.resolves).toHaveLength(1);
    view.unmount();
  });

  it('re-subscribes when the instance changes', async () => {
    const a = create().strybok;
    const b = create({ linkSource: new FakeLinkSource({ initialUrl: invite }) }).strybok;
    const received: string[] = [];
    const view = render(
      ({ strybok }: { strybok: Strybok }) =>
        useStrybokLink(strybok, (link) => received.push(link.routePath)),
      { strybok: a },
    );
    await settle();
    expect(received).toEqual([]);
    view.rerender({ strybok: b });
    await settle();
    expect(received).toEqual(['/p/invite777']);
    view.unmount();
  });

  it('tolerates a disposed instance', async () => {
    const { strybok } = create();
    strybok.dispose();
    const view = render(() => useStrybokLink(strybok, () => {}), {});
    await settle();
    view.unmount();
  });
});
