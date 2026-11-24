// Port of the Flutter SDK's test suite (github.com/strybok/strybok-flutter), the reference test
// list of the SDK contract (docs/sdk-contract.md). Same groups, same cases, same order.
import { describe, expect, it } from 'vitest';
import {
  LinkNotFoundError,
  Strybok,
  type StrybokError,
  StrybokNetworkError,
  StrybokServerError,
  StrybokTimeoutError,
  UnsupportedLinkError,
  type FetchResponseLike,
  type ResolvedLink,
} from '../src/index.js';
import { FakeLinkSource } from '../src/testing.js';
import { Api, apiBaseUrl, bridge, host, invite, never, ok, response, settle } from './helpers.js';

describe('host allowlist and parsing', () => {
  const sdk = new Strybok({
    apiBaseUrl,
    allowedHosts: ['My-App.Strybok.Link'],
    linkSource: new FakeLinkSource(),
  });

  it('accepts https links on an allowed host with a single slug', () => {
    expect(sdk.isStrybokUrl(invite)).toBe(true);
    expect(sdk.isStrybokUrl('https://MY-APP.strybok.link/AbC_7-x')).toBe(true);
    expect(sdk.isStrybokUrl(`https://${host}/abc?utm=1#frag`)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const url of [
      `http://${host}/invite777`,
      `myapp://${host}/invite777`,
      'https://evil.example.com/invite777',
      `https://${host}.evil.example.com/invite777`,
      `https://evil-${host}/invite777`,
      `https://user:pw@${host}/invite777`,
      `https://${host}:8443/invite777`,
      `https://${host}/`,
      `https://${host}/a/b`,
      `https://${host}/.well-known/assetlinks.json`,
      `https://${host}/a%2Fb`,
    ]) {
      expect(sdk.isStrybokUrl(url), url).toBe(false);
    }
  });

  it('resolveUrl refuses foreign links without any network call', async () => {
    const api = new Api();
    const sdk = bridge(api);
    const foreign = 'https://evil.example.com/invite777';
    const error = await sdk.resolveUrl(foreign).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedLinkError);
    expect((error as UnsupportedLinkError).url).toBe(foreign);
    expect(api.resolves).toHaveLength(0);
  });
});

describe('resolveUrl', () => {
  it('returns route and payload and sends only host and slug to the API', async () => {
    const api = new Api();
    const url = `https://${host}/invite777?token=secret#f`;
    const link = await bridge(api).resolveUrl(url);

    expect(link.routePath).toBe('/invite/abc123');
    expect(link.payload).toEqual({ invitationId: 'abc123' });
    expect(link.linkId).toBe('link_1');
    expect(link.appId).toBe('app_1');
    expect(link.url).toBe(url);

    expect(api.resolves).toHaveLength(1);
    const request = api.resolves[0]!;
    expect(request.init.method).toBe('GET');
    expect(request.init.headers).toEqual({ Accept: 'application/json' });
    expect(request.init.body).toBeUndefined();
    expect(request.path).toBe('/v1/public/resolve');
    expect(request.query).toEqual({ url: `https://${host}/invite777` });
    expect(request.url).toBe(
      `${apiBaseUrl}/v1/public/resolve?url=https%3A%2F%2F${host}%2Finvite777`,
    );
    expect(request.url).not.toContain('secret');
    // Explicit resolution is not an app open.
    await settle();
    expect(api.events).toHaveLength(0);
  });

  it('keeps a path prefix of the API base URL', async () => {
    const api = new Api();
    const sdk = bridge(api, { apiBaseUrl: 'https://example.com/strybok/' });
    await sdk.resolveUrl(invite);
    expect(api.resolves[0]!.url.startsWith('https://example.com/strybok/v1/public/resolve?')).toBe(
      true,
    );
  });

  it('404 becomes LinkNotFoundError and is not retried', async () => {
    const api = new Api(() => response(404, '{"error":{"code":"LINK_NOT_FOUND"}}'));
    await expect(bridge(api).resolveUrl(invite)).rejects.toBeInstanceOf(LinkNotFoundError);
    expect(api.resolves).toHaveLength(1);
  });

  it('other client errors are not retried', async () => {
    const api = new Api(() => response(422, '{}'));
    const error = await bridge(api)
      .resolveUrl(invite)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StrybokServerError);
    expect((error as StrybokServerError).statusCode).toBe(422);
    expect(api.resolves).toHaveLength(1);
  });

  it('retries network errors and then succeeds', async () => {
    let calls = 0;
    const api = new Api(() => {
      calls++;
      if (calls < 3) throw new TypeError('connection reset');
      return ok();
    });
    const link = await bridge(api).resolveUrl(invite);
    expect(link.routePath).toBe('/invite/abc123');
    expect(calls).toBe(3);
  });

  it('gives up with a network error after maxRetries', async () => {
    const cause = new TypeError('offline');
    const api = new Api(() => {
      throw cause;
    });
    const error = await bridge(api, { maxRetries: 1 })
      .resolveUrl(invite)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StrybokNetworkError);
    expect((error as StrybokNetworkError).cause).toBe(cause);
    expect((error as StrybokNetworkError).url).toBe(invite);
    expect(api.resolves).toHaveLength(2);
  });

  it('retries 5xx responses', async () => {
    let calls = 0;
    const api = new Api(() => (++calls === 1 ? response(503) : ok()));
    await bridge(api).resolveUrl(invite);
    expect(calls).toBe(2);
  });

  it('times out with a typed error', async () => {
    const api = new Api(() => never<FetchResponseLike>());
    await expect(bridge(api, { maxRetries: 1 }).resolveUrl(invite)).rejects.toBeInstanceOf(
      StrybokTimeoutError,
    );
    expect(api.resolves).toHaveLength(2);
  });

  it('rejects malformed or unsafe responses', async () => {
    for (const body of [
      'not json',
      '[]',
      '{"linkId":"l","appId":"a"}',
      '{"linkId":"l","appId":"a","routePath":"https://evil.example.com"}',
      '{"linkId":"l","appId":"a","routePath":"//evil.example.com"}',
      '{"linkId":1,"appId":"a","routePath":"/x"}',
    ]) {
      const api = new Api(() => response(200, body));
      const error = await bridge(api)
        .resolveUrl(invite)
        .catch((e: unknown) => e);
      expect(error, body).toBeInstanceOf(StrybokServerError);
      expect((error as StrybokServerError).statusCode, body).toBe(200);
      expect(api.resolves, body).toHaveLength(1);
    }
  });
});

describe('cold start', () => {
  it('delivers the launch link once, even if the listener attaches late', async () => {
    const api = new Api();
    const sdk = bridge(api, { source: new FakeLinkSource({ initialUrl: invite }) });
    await sdk.initialize();

    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await settle();

    expect(received.map((link) => link.routePath)).toEqual(['/invite/abc123']);
    expect(api.resolves).toHaveLength(1);
  });

  it('de-duplicates a launch link that is replayed on the stream', async () => {
    const api = new Api();
    const sdk = bridge(api, {
      source: new FakeLinkSource({ initialUrl: invite, replayInitialUrlOnSubscribe: true }),
    });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();
    await settle();

    expect(received).toHaveLength(1);
    expect(api.resolves).toHaveLength(1);
    expect(api.events).toHaveLength(1);
  });

  it('getInitialLink consumes the launch link so the stream does not repeat it', async () => {
    const sdk = bridge(new Api(), { source: new FakeLinkSource({ initialUrl: invite }) });
    const initial = await sdk.getInitialLink();
    expect(initial?.routePath).toBe('/invite/abc123');
    expect(await sdk.getInitialLink()).toBeNull();

    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await settle();
    expect(received).toHaveLength(0);
  });

  it('getInitialLink returns null once the stream already delivered it', async () => {
    const sdk = bridge(new Api(), { source: new FakeLinkSource({ initialUrl: invite }) });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();
    await settle();
    expect(received).toHaveLength(1);
    expect(await sdk.getInitialLink()).toBeNull();
  });

  it('no launch link, foreign launch link and repeated initialize are harmless', async () => {
    const api = new Api();
    const errors: StrybokError[] = [];
    const source = new FakeLinkSource({ initialUrl: 'https://other.example.com/x' });
    const sdk = bridge(api, { source, errors });
    await Promise.all([sdk.initialize(), sdk.initialize()]);
    expect(sdk.initialize()).toBe(sdk.initialize());
    expect(await sdk.getInitialLink()).toBeNull();
    expect(api.resolves).toHaveLength(0);
    expect(errors).toHaveLength(0);

    const none = bridge(api, { source: new FakeLinkSource(), errors });
    await none.initialize();
    expect(await none.getInitialLink()).toBeNull();
    expect(api.resolves).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('a failing launch link is reported through onError and initialize completes', async () => {
    const errors: StrybokError[] = [];
    const sdk = bridge(new Api(() => response(404)), {
      source: new FakeLinkSource({ initialUrl: invite }),
      errors,
    });
    await sdk.initialize();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LinkNotFoundError);
    expect(errors[0]!.url).toBe(invite);
    expect(await sdk.getInitialLink()).toBeNull();
  });
});

describe('running app', () => {
  it('delivers each foreground link exactly once', async () => {
    const api = new Api((request) => {
      const slug = request.query.url!.slice(`https://${host}/`.length);
      return ok({ route: `/p/${slug}`, linkId: `link_${slug}` });
    });
    const source = new FakeLinkSource();
    const sdk = bridge(api, { source });
    const received: string[] = [];
    sdk.onLink((link) => received.push(link.routePath));
    await sdk.initialize();

    source.emit(`https://${host}/first`);
    source.emit(`https://${host}/second`);
    source.emit('https://evil.example.com/third');
    await settle();

    expect([...received].sort()).toEqual(['/p/first', '/p/second']);
    expect(api.resolves).toHaveLength(2);
  });

  it('drops an immediate duplicate but honours the same link tapped again later', async () => {
    let now = Date.UTC(2026, 0, 1);
    const source = new FakeLinkSource();
    const api = new Api();
    const sdk = bridge(api, { source, now: () => now });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    source.emit(invite);
    source.emit(invite);
    await settle();
    expect(received).toHaveLength(1);

    // App paused, user taps the same link again a minute later (resume).
    now += 60_000;
    source.emit(invite);
    await settle();
    expect(received).toHaveLength(2);
    expect(api.resolves).toHaveLength(2);
  });

  it('multiple listeners each see a link once', async () => {
    const source = new FakeLinkSource();
    const sdk = bridge(new Api(), { source });
    const a: ResolvedLink[] = [];
    const b: ResolvedLink[] = [];
    sdk.onLink((link) => a.push(link));
    sdk.onLink((link) => b.push(link));
    await sdk.initialize();
    source.emit(invite);
    await settle();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('errors go to onError and the stream keeps working', async () => {
    let fail = true;
    const errors: StrybokError[] = [];
    const source = new FakeLinkSource();
    const api = new Api(() => {
      if (fail) throw new TypeError('offline');
      return ok();
    });
    const sdk = bridge(api, { source, errors, maxRetries: 0 });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    source.emit(`https://${host}/offline1`);
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StrybokNetworkError);
    expect(received).toHaveLength(0);

    fail = false;
    source.emit(`https://${host}/online1`);
    await settle();
    expect(received).toHaveLength(1);
  });
});

describe('app_open events', () => {
  it('sends one minimal best-effort event per delivered link', async () => {
    const api = new Api();
    const source = new FakeLinkSource();
    const sdk = bridge(api, { source, platform: 'android' });
    sdk.onLink(() => {});
    await sdk.initialize();
    source.emit(invite);
    await settle();

    expect(api.events).toHaveLength(1);
    const event = api.events[0]!;
    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'linkId',
      'platform',
      'sdkVersion',
      'type',
    ]);
    expect(event.type).toBe('app_open');
    expect(event.linkId).toBe('link_1');
    expect(event.platform).toBe('android');
    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const request = api.eventRequests[0]!;
    expect(request.url).toBe(`${apiBaseUrl}/v1/public/events`);
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('a slow or failing events endpoint never delays or breaks delivery', async () => {
    const behaviours: (() => FetchResponseLike | Promise<FetchResponseLike>)[] = [
      () => never<FetchResponseLike>(),
      () => {
        throw new TypeError('down');
      },
      () => response(500),
    ];
    for (const onEvent of behaviours) {
      const api = new Api();
      api.onEvent = onEvent;
      const source = new FakeLinkSource();
      const errors: StrybokError[] = [];
      const sdk = bridge(api, { source, errors });
      const received: ResolvedLink[] = [];
      sdk.onLink((link) => received.push(link));
      await sdk.initialize();
      source.emit(invite);
      await settle();
      expect(received).toHaveLength(1);
      expect(errors).toHaveLength(0);
      await settle(80); // Let the hanging request time out: still no error.
      expect(errors).toHaveLength(0);
    }
  });

  it('can be turned off', async () => {
    const api = new Api();
    const source = new FakeLinkSource({ initialUrl: invite });
    const sdk = bridge(api, { source, reportAppOpens: false });
    await sdk.initialize();
    await settle();
    expect(api.resolves).toHaveLength(1);
    expect(api.events).toHaveLength(0);
  });
});

describe('dispose', () => {
  it('stops delivery, closes the stream and rejects further use', async () => {
    const api = new Api();
    const source = new FakeLinkSource();
    const sdk = bridge(api, { source });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();
    expect(source.hasListener).toBe(true);

    sdk.dispose();
    sdk.dispose(); // idempotent
    expect(source.hasListener).toBe(false);

    source.emit(invite);
    await settle();
    expect(received).toHaveLength(0);
    expect(api.resolves).toHaveLength(0);
    await expect(sdk.resolveUrl(invite)).rejects.toThrow('disposed');
    await expect(sdk.initialize()).rejects.toThrow('disposed');
    await expect(sdk.getInitialLink()).rejects.toThrow('disposed');
    // Listening after dispose is a harmless no-op.
    const unsubscribe = sdk.onLink((link) => received.push(link));
    unsubscribe();
  });

  it('a link still resolving when disposed is not delivered', async () => {
    let answer!: (value: FetchResponseLike) => void;
    const pending = new Promise<FetchResponseLike>((resolve) => {
      answer = resolve;
    });
    const source = new FakeLinkSource();
    const errors: StrybokError[] = [];
    const api = new Api(() => pending);
    const sdk = bridge(api, { source, errors, timeoutMs: 5000 });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();
    source.emit(invite);
    await settle();
    expect(api.resolves).toHaveLength(1);

    sdk.dispose();
    answer(ok());
    await settle();
    expect(received).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(api.events).toHaveLength(0);
  });
});
