// Links without an API call (SDK contract, "Links without an API call", decision 0035): the
// shared test vectors, run in full, and the behaviour around them. test/fixtures holds a
// byte-identical copy of the contract's vectors file; never edit it here.
import { describe, expect, it } from 'vitest';
import vectorFile from './fixtures/parameter-links-vectors.json' with { type: 'json' };
import {
  Strybok,
  UnsupportedLinkError,
  type DeferredLinkStatus,
  type ParameterLinksOptions,
  type ResolvedLink,
  type StrybokError,
  type StrybokOptions,
} from '../src/index.js';
import { pastedClickId } from '../src/deferred.js';
import { FakeLinkSource } from '../src/testing.js';
import { parseStrybokLink } from '../src/url.js';
import { Api, apiBaseUrl, bridge, response, settle } from './helpers.js';

interface LookupCase {
  readonly name: string;
  readonly parameterLinks: ParameterLinksOptions | null;
  readonly url: string;
  readonly lookup: string | null;
}

interface ConfigurationCase {
  readonly name: string;
  readonly parameterLinks: ParameterLinksOptions | null;
  readonly valid: boolean;
}

const vectors = vectorFile as unknown as {
  readonly allowedHosts: readonly string[];
  readonly lookups: readonly LookupCase[];
  readonly configurations: readonly ConfigurationCase[];
};

const { allowedHosts } = vectors;
const resolveRequest = (lookup: string) =>
  `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(lookup)}`;
const keys = { payloadKeys: ['id', 'lang'] };
const host = 'myapp.strybok.link';

describe('the shared vectors', () => {
  it('are all here: 90 lookups and 19 configurations', () => {
    expect(vectors.lookups).toHaveLength(90);
    expect(vectors.configurations).toHaveLength(19);
    expect(allowedHosts).toEqual(['myapp.strybok.link', 'go.example.com']);
  });

  describe('resolveUrl sends exactly the lookup, or rejects without a request', () => {
    for (const vector of vectors.lookups) {
      it(vector.name, async () => {
        const api = new Api();
        const sdk = bridge(api, { allowedHosts, parameterLinks: vector.parameterLinks });
        expect(sdk.isStrybokUrl(vector.url)).toBe(vector.lookup !== null);

        if (vector.lookup === null) {
          const error = await sdk.resolveUrl(vector.url).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(UnsupportedLinkError);
          expect(error).toMatchObject({ kind: 'unsupported_link', url: vector.url });
          expect(api.resolves).toEqual([]);
          return;
        }
        const link = await sdk.resolveUrl(vector.url);
        expect(link.url).toBe(vector.url);
        expect(api.resolves).toHaveLength(1);
        const request = api.resolves[0]!;
        expect(request.url).toBe(resolveRequest(vector.lookup));
        expect(request.query).toEqual({ url: vector.lookup });
        expect(request.init.method).toBe('GET');
        expect(request.init.headers).toEqual({ Accept: 'application/json' });
        expect(request.init.body).toBeUndefined();
      });
    }
  });

  describe('the automatic flow sends exactly the lookup, or drops the URL silently', () => {
    for (const vector of vectors.lookups) {
      it(vector.name, async () => {
        const api = new Api();
        const errors: StrybokError[] = [];
        const received: ResolvedLink[] = [];
        const sdk = bridge(api, {
          allowedHosts,
          parameterLinks: vector.parameterLinks,
          source: new FakeLinkSource({ initialUrl: vector.url }),
          errors,
        });
        sdk.onLink((link) => received.push(link));
        await sdk.initialize();

        expect(errors).toEqual([]);
        if (vector.lookup === null) {
          expect(api.resolves).toEqual([]);
          expect(received).toEqual([]);
          return;
        }
        expect(api.resolves.map((request) => request.url)).toEqual([resolveRequest(vector.lookup)]);
        expect(received.map((link) => link.url)).toEqual([vector.url]);
      });
    }
  });

  describe('configurations are accepted or rejected', () => {
    for (const vector of vectors.configurations) {
      it(`${vector.name}: ${vector.valid ? 'valid' : 'invalid'}`, () => {
        const create = () =>
          new Strybok({
            apiBaseUrl,
            allowedHosts,
            linkSource: new FakeLinkSource(),
            fetch: new Api().fetch,
            parameterLinks: vector.parameterLinks,
          });
        if (!vector.valid) {
          // Exactly like every other invalid option (an invalid apiBaseUrl, say).
          expect(create).toThrow(TypeError);
          expect(create).toThrow(/^Strybok: parameterLinks/);
          return;
        }
        const sdk = create();
        expect(sdk.parameterLinks).toEqual(vector.parameterLinks);
      });
    }
  });
});

describe('parseStrybokLink with payload keys, beyond the vectors', () => {
  const hosts = new Set(allowedHosts);
  const lookup = (url: string, payloadKeys: readonly string[] = ['id', 'lang']) =>
    parseStrybokLink(url, hosts, payloadKeys)?.lookupUrl ?? null;
  const long = (link: string, rest = '') =>
    `https://go.example.com/?link=${encodeURIComponent(link)}${rest}`;

  it.each<[string, string, string | null]>([
    // Values JavaScript can hold but UTF-8 cannot: treated like values that cannot be decoded.
    [
      'a lone surrogate in a payload value',
      `https://${host}/p/1?id=\uD800&lang=uk`,
      `https://${host}/p/1?lang=uk`,
    ],
    [
      'a lone surrogate in a deep link',
      'https://go.example.com/?link=https://example.com/\uDC00',
      null,
    ],
    ['a lone surrogate in apn', `${long('https://example.com/p')}&apn=\uD800`, null],
    // Characters above U+0020 are fine in a deep link, line separators included.
    [
      'U+2028 in a deep link path',
      long('https://example.com/a\u2028b'),
      long('https://example.com/a\u2028b'),
    ],
    ['a backslash in a deep link', long('https://example.com\\@evil.example/'), null],
    ['U+007F in a deep link', long('https://example.com/a\u007f'), null],
    ['an upper-case deep link scheme', long('HTTPS://Example.COM'), long('https://example.com/')],
    [
      'a deep link query right after the host',
      long('https://example.com?id=7&x=1'),
      long('https://example.com/?id=7'),
    ],
    [
      'a deep link payload value that cannot be decoded',
      long('https://example.com/p?id=%E0%A4&lang=uk'),
      long('https://example.com/p?lang=uk'),
    ],
    [
      'utm_* inside a deep link (never a payload key)',
      long('https://example.com/p?utm_source=x', '&utm_source=y'),
      `${long('https://example.com/p')}&utm_source=y`,
    ],
    [
      'payload keys of the outer URL of a long link',
      `${long('https://example.com/p')}&id=7`,
      long('https://example.com/p'),
    ],
    // The deep link's host only has to be made of host characters; the server decides the rest.
    ['a dotted IPv4 deep link host', long('https://192.0.2.1/p'), long('https://192.0.2.1/p')],
    // `link` is found like any key: decoded, first occurrence, a part without "=" is empty.
    [
      'an encoded link key',
      'https://go.example.com/?%6Cink=https%3A%2F%2Fexample.com',
      long('https://example.com/'),
    ],
    ['link without "="', 'https://go.example.com/?link&id=7', null],
    [
      'a link key that cannot be decoded',
      'https://go.example.com/?li%ZZnk=https%3A%2F%2Fexample.com&id=7',
      'https://go.example.com/?id=7',
    ],
    // Route paths, as received.
    ['an encoded slash', `https://${host}/a%2Fb`, `https://${host}/a%2Fb`],
    ['a dot segment spelled with one escape', `https://${host}/a/%2e./b`, null],
    ['a dot segment at the end', `https://${host}/a/..`, null],
    [
      '/_strybok itself is a slug, checked first',
      `https://${host}/_strybok?id=7`,
      `https://${host}/_strybok?id=7`,
    ],
    ['under /_strybok', `https://${host}/_strybok/`, null],
    [
      'a reserved name in another case',
      `https://${host}/Favicon.ico`,
      `https://${host}/Favicon.ico`,
    ],
    // Payload values: C1 control characters are dropped, U+00A0 is kept.
    [
      'U+009F in a payload value',
      `https://${host}/p?id=%C2%9F&lang=uk`,
      `https://${host}/p?lang=uk`,
    ],
    ['U+00A0 in a payload value', `https://${host}/p?id=%C2%A0`, `https://${host}/p?id=%C2%A0`],
  ])('%s', (_name, url, expected) => {
    expect(lookup(url)).toBe(expected);
  });

  it('reads "link" as a payload key on any other path', () => {
    expect(lookup(`https://${host}/product?link=abc`, ['link'])).toBe(
      `https://${host}/product?link=abc`,
    );
    expect(lookup(long('https://example.com/p?link=abc&id=1'), ['link'])).toBe(
      long('https://example.com/p?link=abc'),
    );
  });

  it('without payload keys sends what 0.3.0 sent, or nothing', () => {
    for (const url of [`https://${host}/promo?id=7&utm_source=a`, `https://${host}/a/b`]) {
      expect(parseStrybokLink(url, hosts)).toEqual(parseStrybokLink(url, hosts, null));
    }
    expect(parseStrybokLink(`https://${host}/a/b`, hosts)).toBeNull();
    expect(parseStrybokLink(`https://${host}/a/b`, hosts, [])?.lookupUrl).toBe(
      `https://${host}/a/b`,
    );
  });
});

describe('the option', () => {
  const base: StrybokOptions = {
    apiBaseUrl,
    allowedHosts,
    linkSource: new FakeLinkSource(),
    fetch: new Api().fetch,
  };

  it('is not set by default; null means the same', () => {
    expect(new Strybok(base).parameterLinks).toBeNull();
    expect(new Strybok({ ...base, parameterLinks: null }).parameterLinks).toBeNull();
    expect(new Strybok({ ...base, parameterLinks: undefined }).parameterLinks).toBeNull();
  });

  it('is copied: changing the array afterwards changes nothing', async () => {
    const payloadKeys = ['id'];
    const api = new Api();
    const sdk = bridge(api, { allowedHosts, parameterLinks: { payloadKeys } });
    payloadKeys.push('lang');
    payloadKeys[0] = 'other';
    expect(sdk.parameterLinks).toEqual({ payloadKeys: ['id'] });
    expect(Object.isFrozen(sdk.parameterLinks)).toBe(true);
    expect(Object.isFrozen(sdk.parameterLinks?.payloadKeys)).toBe(true);
    await sdk.resolveUrl(`https://${host}/p/1?id=7&lang=uk&other=x`);
    expect(api.resolves[0]!.query).toEqual({ url: `https://${host}/p/1?id=7` });
  });

  it('ignores fields it does not know', () => {
    const parameterLinks = { payloadKeys: ['id'], routePatterns: ['/p/*'] };
    expect(new Strybok({ ...base, parameterLinks }).parameterLinks).toEqual({
      payloadKeys: ['id'],
    });
  });

  it.each<[string, unknown]>([
    ['a list instead of the object', ['id']],
    ['an object without payloadKeys', {}],
    ['payloadKeys that is not a list', { payloadKeys: 'id' }],
    ['payloadKeys that is a set', { payloadKeys: new Set(['id']) }],
    ['a key that is not a string', { payloadKeys: [7] }],
    ['an undefined key', { payloadKeys: [undefined, 'id'] }],
    ['a key with surrounding spaces (never trimmed)', { payloadKeys: [' id'] }],
    ['true', true],
    ['a string', 'id'],
  ])('rejects %s like any invalid option', (_name, parameterLinks) => {
    expect(() => new Strybok({ ...base, parameterLinks } as unknown as StrybokOptions)).toThrow(
      /^Strybok: parameterLinks/,
    );
  });
});

describe('links without an API call', () => {
  const answer = (fields: Record<string, unknown>) => () =>
    response(200, JSON.stringify({ appId: 'app_1', ...fields }));

  it('deliver the route and payload of the answer, never those of the tapped URL', async () => {
    const api = new Api(
      answer({
        linkId: 'link_path',
        routePath: '/catalog/item',
        payload: { sku: 'A-1' },
        campaign: { source: 'newsletter' },
      }),
    );
    const source = new FakeLinkSource();
    const sdk = bridge(api, { allowedHosts, parameterLinks: keys, source });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    const tapped = `https://${host}/product/42?id=7&lang=uk&utm_source=mail#reviews`;
    source.emit(tapped);
    await settle();
    expect(received).toEqual([
      {
        url: tapped,
        linkId: 'link_path',
        appId: 'app_1',
        routePath: '/catalog/item',
        payload: { sku: 'A-1' },
        campaign: { source: 'newsletter' },
        isDeferred: false,
        isProbabilisticMatch: false,
      },
    ]);
  });

  it('deliver a long link with the route and payload of the answer', async () => {
    const api = new Api(
      answer({ linkId: 'link_firebase', routePath: '/product/42', payload: { id: '7' } }),
    );
    const tapped =
      'https://go.example.com/?link=https%3A%2F%2Fexample.com%2Fproduct%2F42%3Fid%3D7&apn=com.example.app';
    const link = await bridge(api, { allowedHosts, parameterLinks: keys }).resolveUrl(tapped);
    expect(link).toMatchObject({
      url: tapped,
      linkId: 'link_firebase',
      routePath: '/product/42',
      payload: { id: '7' },
    });
  });

  it('report app_open with the linkId of the answer', async () => {
    const api = new Api(answer({ linkId: 'link_path_kind', routePath: '/product/42' }));
    const source = new FakeLinkSource();
    const sdk = bridge(api, { allowedHosts, parameterLinks: keys, source, platform: 'android' });
    sdk.onLink(() => {});
    await sdk.initialize();
    source.emit(`https://${host}/product/42?id=7`);
    await settle();
    expect(api.events).toEqual([
      {
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        linkId: 'link_path_kind',
        type: 'app_open',
        platform: 'android',
        sdkVersion: expect.any(String) as unknown,
      },
    ]);
  });

  it('report an address that is no link like an unknown slug: LinkNotFound to onError', async () => {
    const api = new Api(() => response(404));
    const errors: StrybokError[] = [];
    const tapped = `https://${host}/no/such/route`;
    const sdk = bridge(api, {
      allowedHosts,
      parameterLinks: keys,
      source: new FakeLinkSource({ initialUrl: tapped }),
      errors,
    });
    await sdk.initialize();
    expect(errors).toMatchObject([{ kind: 'link_not_found', url: tapped }]);
  });

  it('are de-duplicated by the URL as received, as every link', async () => {
    const api = new Api(answer({ linkId: 'l', routePath: '/p' }));
    const source = new FakeLinkSource();
    const sdk = bridge(api, { allowedHosts, parameterLinks: keys, source });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();
    source.emit(`https://${host}/p/1?id=7&x=1`);
    source.emit(`https://${host}/p/1?id=7&x=1`);
    source.emit(`https://${host}/p/1?id=7&x=2`);
    await settle();
    expect(received.map((link) => link.url)).toEqual([
      `https://${host}/p/1?id=7&x=1`,
      `https://${host}/p/1?id=7&x=2`,
    ]);
    // Two taps, the same lookup: the difference was never sent.
    expect(new Set(api.resolves.map((request) => request.url))).toEqual(
      new Set([resolveRequest(`https://${host}/p/1?id=7`)]),
    );
  });

  it('without the option, every URL of the vectors is handled by the slug rule alone', async () => {
    const hosts = new Set(allowedHosts);
    for (const vector of vectors.lookups) {
      const api = new Api();
      const sdk = bridge(api, { allowedHosts });
      const expected = parseStrybokLink(vector.url, hosts)?.lookupUrl ?? null;
      const sent = await sdk.resolveUrl(vector.url).then(
        () => api.resolves[0]!.query.url,
        () => null,
      );
      expect(sent, vector.name).toBe(expected);
      expect(api.resolves.length, vector.name).toBe(expected === null ? 0 : 1);
      if (vector.parameterLinks === null) expect(sent, vector.name).toBe(vector.lookup);
    }
  });
});

describe('deferred links keep the slug rule with the option', () => {
  const clickId = `dc_${'aB3x'.repeat(8)}`;

  /** Survives nothing; enough for one launch. */
  function memoryStore() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  }

  function android(redeemedUrl: string, launchUrl: string | null = null) {
    const api = new Api((request) =>
      request.path.endsWith('/deferred-links/redeem')
        ? response(
            200,
            JSON.stringify({
              linkId: 'link_d',
              appId: 'app_1',
              routePath: '/invite/abc123',
              url: redeemedUrl,
              deferred: true,
            }),
          )
        : response(200, JSON.stringify({ linkId: 'link_n', appId: 'app_1', routePath: '/n' })),
    );
    const statuses: DeferredLinkStatus[] = [];
    const received: ResolvedLink[] = [];
    const sdk = bridge(api, {
      allowedHosts,
      parameterLinks: keys,
      source: new FakeLinkSource({ initialUrl: launchUrl }),
      platform: 'android',
      deferredLinks: true,
      deferredLinkStore: memoryStore(),
      androidPackageName: 'com.example.app',
      installReferrerSources: [
        () => ({ status: 'referrer', referrer: `strybok_click=${clickId}` }),
      ],
    });
    sdk.onDeferredLinkStatus((status) => statuses.push(status));
    sdk.onLink((link) => received.push(link));
    return { api, sdk, statuses, received };
  }

  async function finished(launched: ReturnType<typeof android>) {
    await launched.sdk.initialize();
    await expect
      .poll(() => launched.sdk.deferredLinkStatus, { interval: 5 })
      .not.toMatch(/^(checking|pending)$/);
  }

  it.each([
    ['several path segments', `https://${host}/product/42`],
    ['a trailing slash', `https://${host}/invite777/`],
    ['the root', `https://${host}/`],
    ['a Firebase long link', 'https://go.example.com/?link=https%3A%2F%2Fexample.com%2Fp'],
  ])('refuses an answer whose URL has %s', async (_name, url) => {
    const launched = android(url);
    await finished(launched);
    expect(launched.sdk.isStrybokUrl(url)).toBe(true); // Ours for the automatic flow...
    expect(launched.sdk.deferredLinkStatus).toBe('failed'); // ...but no deferred link.
    expect(launched.received).toEqual([]);
    expect(launched.api.resolves.filter((r) => r.path.endsWith('/redeem'))).toHaveLength(1);
  });

  it('still delivers an answer with one slug', async () => {
    const launched = android(`https://${host}/invite777`);
    await finished(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('delivered');
    expect(launched.received).toMatchObject([{ linkId: 'link_d', isDeferred: true }]);
  });

  it('counts a path link that opened the app as a normal link, which wins', async () => {
    const launched = android(`https://${host}/invite777`, `https://${host}/product/42?id=7`);
    await finished(launched);
    expect(launched.sdk.deferredLinkStatus).toBe('superseded');
    expect(launched.received).toMatchObject([{ linkId: 'link_n', isDeferred: false }]);
  });

  it('takes the click id of a pasted text with one slug only', () => {
    const hosts = new Set(allowedHosts);
    expect(pastedClickId(`https://${host}/invite777?strybok_click=${clickId}`, hosts)).toBe(
      clickId,
    );
    for (const pasted of [
      `https://${host}/product/42?strybok_click=${clickId}`,
      `https://${host}/?strybok_click=${clickId}`,
      `https://go.example.com/?link=https%3A%2F%2Fexample.com%2Fp&strybok_click=${clickId}`,
    ]) {
      expect(pastedClickId(pasted, hosts), pasted).toBeNull();
    }
  });

  it('answers notOurs for a pasted path link, without a request', async () => {
    const api = new Api();
    const sdk = bridge(api, {
      allowedHosts,
      parameterLinks: keys,
      platform: 'ios',
      deferredLinks: true,
      deferredLinkStore: memoryStore(),
      iosBundleId: 'com.example.App',
    });
    const result = await sdk.redeemPastedLink(`https://${host}/a/b?strybok_click=${clickId}`);
    expect(result).toBe('notOurs');
    expect(api.resolves).toEqual([]);
  });
});
