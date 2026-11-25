// Behaviour specific to the JavaScript core, beyond the reference test list.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import {
  SDK_VERSION,
  Strybok,
  StrybokError,
  StrybokServerError,
  StrybokTimeoutError,
  type FetchLike,
  type FetchRequestInit,
  type FetchResponseLike,
  type LinkSource,
  type ResolvedLink,
  type StrybokOptions,
} from '../src/index.js';
import { FakeLinkSource } from '../src/testing.js';
import { uuidV4 } from '../src/uuid.js';
import { Api, apiBaseUrl, bridge, host, invite, never, ok, response, settle } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('configuration', () => {
  const valid: StrybokOptions = {
    apiBaseUrl,
    allowedHosts: [host],
    linkSource: new FakeLinkSource(),
    fetch: new Api().fetch,
  };

  it('applies the defaults of the contract', () => {
    const sdk = new Strybok(valid);
    expect(sdk.timeoutMs).toBe(5000);
    expect(sdk.maxRetries).toBe(2);
    expect(sdk.retryDelayMs).toBe(400);
    expect(sdk.dedupeWindowMs).toBe(2000);
    expect(sdk.reportAppOpens).toBe(true);
    expect(sdk.platform).toBe('unknown');
    expect(sdk.sdkVersion).toBe(SDK_VERSION);
  });

  it('reports the version of package.json, within the 32 characters the API accepts', () => {
    expect(SDK_VERSION).toBe(packageJson.version);
    expect(SDK_VERSION).toMatch(/^[0-9A-Za-z.+-]{1,32}$/);
  });

  it('accepts any iterable of hosts and lower-cases them', () => {
    const sdk = new Strybok({
      ...valid,
      allowedHosts: new Set(['A.Example.com', 'b.example.com']),
    });
    expect([...sdk.allowedHosts]).toEqual(['a.example.com', 'b.example.com']);
    expect(sdk.isStrybokUrl('https://a.example.com/x')).toBe(true);
    expect(sdk.isStrybokUrl('https://B.EXAMPLE.COM/x')).toBe(true);
  });

  it('rejects invalid options early', () => {
    const invalid: Partial<Record<keyof StrybokOptions, unknown>>[] = [
      { apiBaseUrl: 'api.strybok.com' },
      { apiBaseUrl: 'ftp://api.strybok.com' },
      { apiBaseUrl: 'https://api.strybok.com?x=1' },
      { apiBaseUrl: 'https://api.strybok.com/#x' },
      { apiBaseUrl: '' },
      { apiBaseUrl: undefined },
      { allowedHosts: undefined },
      { allowedHosts: host },
      { allowedHosts: [`https://${host}`] },
      { allowedHosts: [`${host}/`] },
      { allowedHosts: [`${host}:443`] },
      { allowedHosts: ['*.strybok.link'] },
      { allowedHosts: [''] },
      { allowedHosts: [42] },
      { linkSource: undefined },
      { linkSource: {} },
      { platform: 'web' },
      { timeoutMs: -1 },
      { timeoutMs: Number.NaN },
      { retryDelayMs: Number.POSITIVE_INFINITY },
      { dedupeWindowMs: '2s' },
      { maxRetries: -1 },
      { maxRetries: 1.5 },
      { sdkVersion: '' },
      { sdkVersion: 'x'.repeat(33) },
      { sdkVersion: '1.0 beta' },
      { fetch: 'fetch' },
    ];
    for (const override of invalid) {
      expect(
        () => new Strybok({ ...valid, ...override } as StrybokOptions),
        JSON.stringify(override),
      ).toThrow(/^Strybok: /);
    }
    expect(() => new Strybok(undefined as unknown as StrybokOptions)).toThrow(/^Strybok: /);
  });

  it('accepts an empty allowlist: every link is then foreign', () => {
    const sdk = new Strybok({ ...valid, allowedHosts: [] });
    expect(sdk.isStrybokUrl(invite)).toBe(false);
  });

  it('uses the global fetch by default, looked up at request time', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(ok());
    });
    const sdk = new Strybok({ apiBaseUrl, allowedHosts: [host], linkSource: new FakeLinkSource() });
    const link = await sdk.resolveUrl(invite);
    expect(link.linkId).toBe('link_1');
    expect(calls).toHaveLength(1);
  });

  it('requires a fetch option when the runtime has no fetch', () => {
    vi.stubGlobal('fetch', undefined);
    expect(
      () => new Strybok({ apiBaseUrl, allowedHosts: [host], linkSource: new FakeLinkSource() }),
    ).toThrow(/fetch/);
  });

  it('the global fetch and Response satisfy the transport types', () => {
    expectTypeOf(fetch).toExtend<FetchLike>();
    expectTypeOf<Response>().toExtend<FetchResponseLike>();
  });
});

describe('isStrybokUrl and resolveUrl input', () => {
  it('treats non-string input as not ours', async () => {
    const api = new Api();
    const sdk = bridge(api);
    for (const value of [null, undefined, 42, {}]) {
      expect(sdk.isStrybokUrl(value as unknown as string)).toBe(false);
      await expect(sdk.resolveUrl(value as unknown as string)).rejects.toMatchObject({
        kind: 'unsupported_link',
        url: undefined,
      });
    }
    expect(api.resolves).toHaveLength(0);
  });

  it('sends the lower-cased host, the slug as written and no port', async () => {
    const api = new Api();
    await bridge(api).resolveUrl('HTTPS://MY-APP.Strybok.Link:443/InVite_7-x?a=b#c');
    expect(api.resolves[0]!.query).toEqual({ url: `https://${host}/InVite_7-x` });
  });
});

describe('responses', () => {
  it('uses an empty payload when it is missing or not an object', async () => {
    for (const payload of [undefined, null, 'text', 7, true, ['a']]) {
      const api = new Api(() =>
        response(200, JSON.stringify({ linkId: 'l', appId: 'a', routePath: '/x', payload })),
      );
      const link = await bridge(api).resolveUrl(invite);
      expect(link.payload, JSON.stringify(payload)).toEqual({});
    }
  });

  it('keeps nested payload data and ignores unknown response fields', async () => {
    const api = new Api(() =>
      response(
        200,
        JSON.stringify({
          linkId: 'l',
          appId: 'a',
          routePath: '/x',
          payload: { a: { b: [1, 2] }, c: null },
          extra: 'ignored',
        }),
      ),
    );
    const link = await bridge(api).resolveUrl(invite);
    expect(link).toEqual({
      url: invite,
      linkId: 'l',
      appId: 'a',
      routePath: '/x',
      payload: { a: { b: [1, 2] }, c: null },
      campaign: {},
      isDeferred: false,
      isProbabilisticMatch: false,
    });
  });

  it('rejects further malformed bodies', async () => {
    for (const body of ['', 'null', '"text"', '42', '{"linkId":"l","appId":"a","routePath":""}']) {
      const api = new Api(() => response(200, body));
      await expect(bridge(api).resolveUrl(invite), body).rejects.toBeInstanceOf(StrybokServerError);
    }
  });

  it('treats other 2xx and 3xx statuses as server errors without retrying', async () => {
    for (const status of [201, 204, 302, 400, 401, 429]) {
      const api = new Api(() => response(status, '{}'));
      await expect(bridge(api).resolveUrl(invite), `${status}`).rejects.toMatchObject({
        kind: 'server',
        statusCode: status,
      });
      expect(api.resolves, `${status}`).toHaveLength(1);
    }
  });

  it('reports the last 5xx after all retries', async () => {
    const api = new Api(() => response(502));
    await expect(bridge(api, { maxRetries: 2 }).resolveUrl(invite)).rejects.toMatchObject({
      kind: 'server',
      statusCode: 502,
      url: invite,
    });
    expect(api.resolves).toHaveLength(3);
  });

  it('retries when the body cannot be read', async () => {
    let calls = 0;
    const api = new Api(() =>
      ++calls === 1 ? { status: 200, text: () => Promise.reject(new Error('reset')) } : ok(),
    );
    await bridge(api).resolveUrl(invite);
    expect(calls).toBe(2);
  });
});

describe('timeout and retry timing', () => {
  it('aborts the request through AbortController when the timeout fires', async () => {
    const signals: AbortSignal[] = [];
    const api = new Api((request) => {
      const signal = request.init.signal as AbortSignal;
      signals.push(signal);
      // Like a real fetch: reject when aborted.
      return new Promise<FetchResponseLike>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const error = await bridge(api, { maxRetries: 1 })
      .resolveUrl(invite)
      .catch((e: unknown) => e);
    // The abort makes fetch reject as well; the timeout must still win.
    expect(error).toBeInstanceOf(StrybokTimeoutError);
    expect((error as StrybokTimeoutError).url).toBe(invite);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('does not abort a request that answered in time', async () => {
    const signals: AbortSignal[] = [];
    const api = new Api((request) => {
      signals.push(request.init.signal as AbortSignal);
      return ok();
    });
    await bridge(api).resolveUrl(invite);
    await settle(80);
    expect(signals[0]!.aborted).toBe(false);
  });

  it('counts the body download towards the timeout', async () => {
    const api = new Api(() => ({ status: 200, text: () => never<string>() }));
    await expect(bridge(api, { maxRetries: 0 }).resolveUrl(invite)).rejects.toBeInstanceOf(
      StrybokTimeoutError,
    );
  });

  it('still times out in a runtime without AbortController', async () => {
    vi.stubGlobal('AbortController', undefined);
    const inits: FetchRequestInit[] = [];
    const api = new Api((request) => {
      inits.push(request.init);
      return never<FetchResponseLike>();
    });
    await expect(bridge(api, { maxRetries: 0 }).resolveUrl(invite)).rejects.toBeInstanceOf(
      StrybokTimeoutError,
    );
    expect(inits[0]!.signal).toBeUndefined();
  });

  it('waits retryDelay before the first retry and doubles it afterwards', async () => {
    vi.useFakeTimers();
    const api = new Api(() => response(503));
    const sdk = bridge(api, { maxRetries: 3, retryDelayMs: 400, timeoutMs: 5000 });
    const outcome = sdk.resolveUrl(invite).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    expect(api.resolves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(api.resolves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.resolves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(799);
    expect(api.resolves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.resolves).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1599);
    expect(api.resolves).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.resolves).toHaveLength(4);
    expect(await outcome).toBeInstanceOf(StrybokServerError);
  });

  it('uses the default 5 s timeout per attempt', async () => {
    vi.useFakeTimers();
    const api = new Api(() => never<FetchResponseLike>());
    const sdk = bridge(api, { timeoutMs: undefined, maxRetries: 0 });
    const outcome = sdk.resolveUrl(invite).catch((e: unknown) => e);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(StrybokTimeoutError);
  });
});

describe('delivery', () => {
  it('delivers queued links asynchronously, in order, to the first listener only', async () => {
    const api = new Api((request) => {
      const slug = request.query.url!.slice(`https://${host}/`.length);
      return ok({ route: `/p/${slug}` });
    });
    const source = new FakeLinkSource({ initialUrl: `https://${host}/one` });
    const sdk = bridge(api, { source });
    await sdk.initialize();
    source.emit(`https://${host}/two`);
    await settle();

    const first: string[] = [];
    sdk.onLink((link) => first.push(link.routePath));
    expect(first).toEqual([]); // Not during onLink itself.
    await Promise.resolve();
    expect(first).toEqual(['/p/one', '/p/two']);

    const second: string[] = [];
    sdk.onLink((link) => second.push(link.routePath));
    await settle();
    expect(second).toEqual([]);
  });

  it('keeps queued links when the first listener is removed again at once', async () => {
    // React StrictMode: effect, cleanup, effect.
    const sdk = bridge(new Api(), { source: new FakeLinkSource({ initialUrl: invite }) });
    await sdk.initialize();
    const a: ResolvedLink[] = [];
    const b: ResolvedLink[] = [];
    sdk.onLink((link) => a.push(link))();
    sdk.onLink((link) => b.push(link));
    await settle();
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it('queues again while no listener is attached', async () => {
    const source = new FakeLinkSource();
    const sdk = bridge(new Api(), { source });
    await sdk.initialize();
    const first: ResolvedLink[] = [];
    const unsubscribe = sdk.onLink((link) => first.push(link));
    unsubscribe();
    unsubscribe(); // idempotent
    source.emit(invite);
    await settle();
    expect(first).toHaveLength(0);

    const second: ResolvedLink[] = [];
    sdk.onLink((link) => second.push(link));
    await settle();
    expect(second).toHaveLength(1);
  });

  it('the same function registered twice is two independent listeners', async () => {
    const source = new FakeLinkSource();
    const sdk = bridge(new Api(), { source });
    const received: ResolvedLink[] = [];
    const listener = (link: ResolvedLink) => received.push(link);
    const first = sdk.onLink(listener);
    sdk.onLink(listener);
    first();
    await sdk.initialize();
    source.emit(invite);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('a throwing listener does not stop the others; the exception surfaces later', async () => {
    const source = new FakeLinkSource();
    const sdk = bridge(new Api(), { source });
    const received: ResolvedLink[] = [];
    sdk.onLink(() => {
      throw new Error('app bug');
    });
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    vi.useFakeTimers();
    source.emit(invite);
    // The exception is rethrown from a timer, outside of the delivery loop.
    const thrown = await vi.advanceTimersByTimeAsync(0).then(
      () => null,
      (error: unknown) => error,
    );
    expect(received).toHaveLength(1);
    expect(thrown).toMatchObject({ message: 'app bug' });
  });

  it('getInitialLink returns the launch link even when the source replayed it first', async () => {
    // The subscription reports the launch URL before getInitialUrl() answers (Capacitor does).
    const api = new Api();
    const sdk = bridge(api, {
      source: new FakeLinkSource({ initialUrl: invite, replayInitialUrlOnSubscribe: true }),
    });
    const initial = await sdk.getInitialLink();
    expect(initial?.routePath).toBe('/invite/abc123');
    expect(api.resolves).toHaveLength(1);
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await settle();
    expect(received).toHaveLength(0);
  });

  it('initialize waits for a launch link that the subscription reported first', async () => {
    let answer!: (value: FetchResponseLike) => void;
    const api = new Api(
      () =>
        new Promise<FetchResponseLike>((resolve) => {
          answer = resolve;
        }),
    );
    const sdk = bridge(api, {
      timeoutMs: 5000,
      source: new FakeLinkSource({ initialUrl: invite, replayInitialUrlOnSubscribe: true }),
    });
    let initialized = false;
    void sdk.initialize().then(() => {
      initialized = true;
    });
    await settle();
    expect(api.resolves).toHaveLength(1);
    expect(initialized).toBe(false);
    answer(ok());
    await settle();
    expect(initialized).toBe(true);
  });

  it('only the launch link is an initial link', async () => {
    const source = new FakeLinkSource();
    const sdk = bridge(new Api(), { source });
    await sdk.initialize();
    source.emit(invite);
    await settle();
    expect(await sdk.getInitialLink()).toBeNull();
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('does not count foreign URLs as duplicates-in-between', async () => {
    const source = new FakeLinkSource();
    const api = new Api();
    const sdk = bridge(api, { source, now: () => 0 });
    sdk.onLink(() => {});
    await sdk.initialize();
    source.emit(invite);
    source.emit('https://other.example.com/x');
    source.emit(invite);
    source.emit(`${invite}?a=1`); // A different URL string is a different tap.
    await settle();
    expect(api.resolves).toHaveLength(2);
  });

  it('a throwing onError handler does not break later links', async () => {
    let fail = true;
    const source = new FakeLinkSource();
    const api = new Api(() => (fail ? response(404) : ok()));
    const sdk = bridge(api, {
      source,
      onError: () => {
        throw new Error('handler bug');
      },
    });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    vi.useFakeTimers();
    source.emit(`https://${host}/gone`);
    const thrown = await vi.advanceTimersByTimeAsync(0).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({ message: 'handler bug' });
    vi.useRealTimers();

    fail = false;
    source.emit(invite);
    await settle();
    expect(received).toHaveLength(1);
  });
});

describe('link sources', () => {
  function sourceWith(getInitialUrl: LinkSource['getInitialUrl']): LinkSource {
    return { getInitialUrl, subscribe: () => () => {} };
  }

  it('treats a failing or odd getInitialUrl as "no launch link"', async () => {
    const api = new Api();
    const errors: StrybokError[] = [];
    const sources = [
      sourceWith(() => Promise.reject(new Error('platform error'))),
      sourceWith(() => {
        throw new Error('sync platform error');
      }),
      sourceWith(() => Promise.resolve(undefined)),
      sourceWith(() => Promise.resolve('')),
      sourceWith(() => Promise.resolve({ url: invite } as unknown as string)),
    ];
    for (const linkSource of sources) {
      const sdk = bridge(api, { linkSource, errors });
      await sdk.initialize();
      expect(await sdk.getInitialLink()).toBeNull();
    }
    expect(api.resolves).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('ignores non-string values from the subscription', async () => {
    let push!: (url: string) => void;
    const linkSource: LinkSource = {
      getInitialUrl: () => Promise.resolve(null),
      subscribe: (listener) => {
        push = listener;
        return () => {};
      },
    };
    const api = new Api();
    const sdk = bridge(api, { linkSource });
    await sdk.initialize();
    push(undefined as unknown as string);
    push({ url: invite } as unknown as string);
    await settle();
    expect(api.resolves).toHaveLength(0);
  });

  it('subscribes before it asks for the launch URL', async () => {
    const order: string[] = [];
    const linkSource: LinkSource = {
      getInitialUrl: () => {
        order.push('getInitialUrl');
        return Promise.resolve(null);
      },
      subscribe: () => {
        order.push('subscribe');
        return () => order.push('unsubscribe');
      },
    };
    const sdk = bridge(new Api(), { linkSource });
    await sdk.initialize();
    sdk.dispose();
    expect(order).toEqual(['subscribe', 'getInitialUrl', 'unsubscribe']);
  });

  it('FakeLinkSource supports several independent subscribers', () => {
    const source = new FakeLinkSource();
    const a: string[] = [];
    const b: string[] = [];
    const stopA = source.subscribe((url) => a.push(url));
    source.subscribe((url) => b.push(url));
    source.emit('one');
    stopA();
    source.emit('two');
    expect(a).toEqual(['one']);
    expect(b).toEqual(['one', 'two']);
    expect(source.hasListener).toBe(true);
  });
});

describe('dispose', () => {
  it('aborts requests in flight', async () => {
    const signals: AbortSignal[] = [];
    const source = new FakeLinkSource();
    const api = new Api((request) => {
      signals.push(request.init.signal as AbortSignal);
      return never<FetchResponseLike>();
    });
    const sdk = bridge(api, { source, timeoutMs: 5000 });
    await sdk.initialize();
    source.emit(invite);
    await settle();
    expect(signals[0]!.aborted).toBe(false);
    sdk.dispose();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('rejects a pending resolveUrl instead of retrying', async () => {
    const api = new Api((request) => {
      const signal = request.init.signal as AbortSignal;
      return new Promise<FetchResponseLike>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const sdk = bridge(api, { timeoutMs: 5000 });
    const outcome = sdk.resolveUrl(invite).catch((e: unknown) => e);
    await settle();
    sdk.dispose();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StrybokError);
    expect((error as Error).message).toContain('disposed');
    expect(api.resolves).toHaveLength(1);
  });

  it('drops queued links and the launch link', async () => {
    const sdk = bridge(new Api(), { source: new FakeLinkSource({ initialUrl: invite }) });
    await sdk.initialize();
    sdk.dispose();
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await settle();
    expect(received).toHaveLength(0);
  });

  it('disposing while the launch URL is still being read delivers nothing', async () => {
    let answer!: (url: string) => void;
    const api = new Api();
    const sdk = bridge(api, {
      linkSource: {
        getInitialUrl: () =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
        subscribe: () => () => {},
      },
    });
    const initialized = sdk.initialize();
    sdk.dispose();
    answer(invite);
    await initialized;
    expect(api.resolves).toHaveLength(0);
  });
});

describe('errors', () => {
  it('carry a name, a kind and the URL, and are real Error instances', async () => {
    const api = new Api(() => response(404));
    const error = await bridge(api)
      .resolveUrl(invite)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StrybokError);
    expect(error).toMatchObject({ name: 'LinkNotFoundError', kind: 'link_not_found', url: invite });
    expect(String(error)).toBe('LinkNotFoundError: No active link matches this URL');
    expect((error as Error).stack).toBeTypeOf('string');
  });
});

describe('uuidV4', () => {
  it('uses crypto.getRandomValues when present', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0xff));
    vi.stubGlobal('crypto', { getRandomValues });
    expect(uuidV4()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('falls back to Math.random without crypto, or when crypto throws', () => {
    const random = vi.spyOn(Math, 'random');
    for (const crypto of [
      undefined,
      {},
      {
        getRandomValues: () => {
          throw new Error('native module missing');
        },
      },
    ]) {
      vi.stubGlobal('crypto', crypto);
      random.mockClear();
      const ids = new Set(Array.from({ length: 200 }, () => uuidV4()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id).toMatch(UUID_V4);
      expect(random).toHaveBeenCalledTimes(200 * 16);
    }
    random.mockRestore();
  });
});
