// `createLink`: every row of the tables in "Creating links" of the SDK contract
// (docs/sdk-contract.md).
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  RouteNotAllowedError,
  Strybok,
  StrybokError,
  StrybokNetworkError,
  StrybokRateLimitedError,
  StrybokServerError,
  StrybokTimeoutError,
  StrybokUnauthorizedError,
  StrybokValidationError,
  type CreatedLink,
  type CreateLinkOptions,
  type FetchRequestInit,
  type FetchResponseLike,
  type StrybokOptions,
} from '../src/index.js';
import { FakeLinkSource } from '../src/testing.js';
import { apiBaseUrl, host, invite, never, response, settle } from './helpers.js';

const clientKey = 'pk_0123456789abcdefghijABCDEFGHIJ01';
const secretValue = 'do-not-leak-this-payload-value';

const created = {
  linkId: 'link_9',
  slug: 'aB3xY9',
  routePath: '/product/42',
  url: `https://${host}/aB3xY9`,
};

type Answer = FetchResponseLike | Promise<FetchResponseLike>;

interface Call {
  readonly url: string;
  readonly init: FetchRequestInit;
}

/** Records every request and answers it with `answer` (201 with `created` by default). */
class Api {
  readonly calls: Call[] = [];

  constructor(public answer: (attempt: number) => Answer = () => json(201, created)) {}

  readonly fetch = async (url: string, init: FetchRequestInit): Promise<FetchResponseLike> => {
    this.calls.push({ url, init });
    return this.answer(this.calls.length);
  };
}

function json(status: number, body: unknown, headers?: Record<string, string>): FetchResponseLike {
  return {
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    ...(headers ? { headers: new Headers(headers) } : {}),
  };
}

function sdk(api: Api, options: Partial<StrybokOptions> = {}): Strybok {
  const instance = new Strybok({
    apiBaseUrl,
    allowedHosts: [host],
    linkSource: new FakeLinkSource(),
    fetch: api.fetch,
    clientKey,
    timeoutMs: 60,
    retryDelayMs: 1,
    ...options,
  });
  onTestFinished(() => instance.dispose());
  return instance;
}

async function failure(promise: Promise<CreatedLink>): Promise<StrybokError> {
  const error = await promise.then(
    (link) => {
      throw new Error(`Expected a failure, got ${JSON.stringify(link)}`);
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(StrybokError);
  return error as StrybokError;
}

/** Everything of an error that could end up in a log or a crash report. */
function dump(error: unknown): string {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return String(value);
    if (seen.has(value)) return '';
    seen.add(value);
    const own = Object.getOwnPropertyNames(value).map(
      (name) => `${name}=${walk((value as Record<string, unknown>)[name])}`,
    );
    return `${value instanceof Error ? `${value.name}: ${value.message} ` : ''}{${own.join(',')}}`;
  };
  return `${String(error)} ${walk(error)}`;
}

describe('createLink: request', () => {
  it('posts the link with the client key and returns the created link (201)', async () => {
    const api = new Api();
    const link = await sdk(api).createLink('/product/42', {
      payload: { productId: 42 },
      title: 'Red shoes',
      description: 'Look at these',
      imageUrl: 'https://cdn.example.com/shoes.png',
    });

    expect(link).toEqual(created);
    expect(api.calls).toHaveLength(1);
    const { url, init } = api.calls[0]!;
    expect(url).toBe('https://api.strybok.com/v1/public/links');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Strybok-Key': clientKey,
    });
    expect(JSON.parse(init.body!)).toEqual({
      routePath: '/product/42',
      payload: { productId: 42 },
      title: 'Red shoes',
      description: 'Look at these',
      imageUrl: 'https://cdn.example.com/shoes.png',
    });
  });

  it('never sends an Authorization header', async () => {
    const api = new Api();
    await sdk(api).createLink('/product/42');
    const names = Object.keys(api.calls[0]!.init.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('authorization');
  });

  it('returns the existing link of an identical request (200)', async () => {
    const api = new Api(() => json(200, created));
    expect(await sdk(api).createLink('/product/42')).toEqual(created);
    expect(api.calls).toHaveLength(1);
  });

  it('returns only the four documented fields', async () => {
    const api = new Api(() => json(201, { ...created, appId: 'app_1', extra: true }));
    const link = await sdk(api).createLink('/product/42');
    expect(Object.keys(link).sort()).toEqual(['linkId', 'routePath', 'slug', 'url']);
  });

  it('omits the arguments that were not given', async () => {
    const api = new Api();
    const strybok = sdk(api);
    await strybok.createLink('/product/42');
    await strybok.createLink('/product/42', {});
    await strybok.createLink('/product/42', {
      payload: undefined,
      title: undefined,
      description: undefined,
      imageUrl: undefined,
    });
    // Plain JavaScript callers pass null for "nothing"; it is not sent either.
    await strybok.createLink('/product/42', {
      payload: null,
      title: null,
      description: null,
      imageUrl: null,
    } as unknown as CreateLinkOptions);
    await strybok.createLink('/product/42', null as unknown as CreateLinkOptions);
    await strybok.createLink('/product/42', { title: 'Red shoes' });
    await strybok.createLink('/product/42', { payload: {} });

    const bodies = api.calls.map((call) => call.init.body);
    expect(bodies).toEqual([
      '{"routePath":"/product/42"}',
      '{"routePath":"/product/42"}',
      '{"routePath":"/product/42"}',
      '{"routePath":"/product/42"}',
      '{"routePath":"/product/42"}',
      '{"routePath":"/product/42","title":"Red shoes"}',
      '{"routePath":"/product/42","payload":{}}',
    ]);
  });

  it('sends nothing but the documented fields', async () => {
    const api = new Api();
    await sdk(api).createLink('/product/42', {
      title: 'Red shoes',
      slug: 'mine',
      expiresAt: '2030-01-01',
    } as CreateLinkOptions);
    expect(JSON.parse(api.calls[0]!.init.body!)).toEqual({
      routePath: '/product/42',
      title: 'Red shoes',
    });
  });

  it('leaves the limits of the other fields to the service', async () => {
    const api = new Api();
    const options = {
      title: 'x'.repeat(500),
      description: 'y'.repeat(5000),
      imageUrl: 'http://not-https.example.com/a.png',
    };
    await sdk(api).createLink('/product/42', options);
    expect(JSON.parse(api.calls[0]!.init.body!)).toEqual({ routePath: '/product/42', ...options });
  });

  it('preserves a path prefix of apiBaseUrl', async () => {
    const api = new Api();
    await sdk(api, { apiBaseUrl: 'https://example.com/strybok/' }).createLink('/product/42');
    expect(api.calls[0]!.url).toBe('https://example.com/strybok/v1/public/links');
  });

  it('does not check the returned url against allowedHosts', async () => {
    const elsewhere = { ...created, url: 'https://links.example.org/aB3xY9' };
    const api = new Api(() => json(201, elsewhere));
    expect(await sdk(api).createLink('/product/42')).toEqual(elsewhere);
  });

  it('accepts route paths up to 512 characters', async () => {
    const api = new Api();
    const longest = `/${'a'.repeat(511)}`;
    await sdk(api).createLink(longest);
    expect(JSON.parse(api.calls[0]!.init.body!)).toEqual({ routePath: longest });
  });
});

describe('createLink: checks before any network call', () => {
  it('fails with Unauthorized when no clientKey is configured', async () => {
    for (const key of [undefined, '', null as unknown as string]) {
      const api = new Api();
      const error = await failure(sdk(api, { clientKey: key }).createLink('/product/42'));
      expect(error).toBeInstanceOf(StrybokUnauthorizedError);
      expect(error.kind).toBe('unauthorized');
      expect(error.name).toBe('StrybokUnauthorizedError');
      expect(api.calls).toHaveLength(0);
    }
  });

  it('checks the clientKey first', async () => {
    const api = new Api();
    const error = await failure(sdk(api, { clientKey: undefined }).createLink('no-slash'));
    expect(error).toBeInstanceOf(StrybokUnauthorizedError);
    expect(api.calls).toHaveLength(0);
  });

  it('rejects a clientKey that is not a string when the SDK is created', () => {
    expect(() => sdk(new Api(), { clientKey: 42 as unknown as string })).toThrow(TypeError);
  });

  it('fails with Validation for a routePath that is not a single-slash path of ≤ 512 chars', async () => {
    const api = new Api();
    const strybok = sdk(api);
    for (const routePath of [
      '',
      'product/42',
      '//evil.example.com',
      '//',
      `/${'a'.repeat(512)}`,
      'https://example.com/product/42',
      undefined,
      null,
      42,
      {},
    ]) {
      const error = await failure(strybok.createLink(routePath as string));
      expect(error, String(routePath)).toBeInstanceOf(StrybokValidationError);
      expect(error.kind).toBe('validation');
      expect(error.name).toBe('StrybokValidationError');
      expect((error as StrybokValidationError).statusCode).toBeUndefined();
      expect((error as StrybokValidationError).issues).toEqual([]);
    }
    expect(api.calls).toHaveLength(0);
  });

  it('fails with Validation for a payload that is not a JSON object', async () => {
    const api = new Api();
    const strybok = sdk(api);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    for (const payload of [
      [1, 2],
      [],
      'text',
      42,
      true,
      new Date(0), // An object in JavaScript, a string in JSON.
      { toJSON: () => [1] },
      { toJSON: () => undefined },
      circular,
      { big: 10n },
    ]) {
      const error = await failure(
        strybok.createLink('/product/42', { payload } as unknown as CreateLinkOptions),
      );
      expect(error, String(payload)).toBeInstanceOf(StrybokValidationError);
      expect((error as StrybokValidationError).statusCode).toBeUndefined();
    }
    expect(api.calls).toHaveLength(0);
  });

  it('fails with Validation for options that are not an object', async () => {
    const api = new Api();
    const error = await failure(
      sdk(api).createLink('/product/42', 'Red shoes' as unknown as CreateLinkOptions),
    );
    expect(error).toBeInstanceOf(StrybokValidationError);
    expect(api.calls).toHaveLength(0);
  });
});

describe('createLink: response handling', () => {
  it('reports a success answer that cannot be read as Server, without retrying', async () => {
    const complete: Record<string, unknown> = created;
    const bodies: (string | undefined)[] = [
      '',
      'not json',
      '<html>captive portal</html>',
      'null',
      '[]',
      '"text"',
      JSON.stringify({}),
      ...['linkId', 'slug', 'routePath', 'url'].flatMap((field) => [
        JSON.stringify({ ...complete, [field]: undefined }),
        JSON.stringify({ ...complete, [field]: 42 }),
        JSON.stringify({ ...complete, [field]: null }),
      ]),
      JSON.stringify({ ...complete, url: `http://${host}/aB3xY9` }),
      JSON.stringify({ ...complete, url: `myapp://${host}/aB3xY9` }),
      JSON.stringify({ ...complete, url: `${host}/aB3xY9` }),
      JSON.stringify({ ...complete, url: '' }),
    ];
    for (const status of [200, 201]) {
      for (const body of bodies) {
        const api = new Api(() => response(status, body));
        const error = await failure(sdk(api).createLink('/product/42'));
        expect(error, body).toBeInstanceOf(StrybokServerError);
        expect(error.kind).toBe('server');
        expect((error as StrybokServerError).statusCode).toBe(status);
        expect(api.calls).toHaveLength(1);
      }
    }
  });

  it('maps 401 to Unauthorized without retrying', async () => {
    const api = new Api(() => json(401, { error: { code: 'UNAUTHORIZED', message: 'No' } }));
    const error = await failure(sdk(api).createLink('/product/42'));
    expect(error).toBeInstanceOf(StrybokUnauthorizedError);
    expect(error.kind).toBe('unauthorized');
    expect(api.calls).toHaveLength(1);
  });

  it('maps 403 to RouteNotAllowed with the routePath, without retrying', async () => {
    const api = new Api(() => json(403, { error: { code: 'ROUTE_NOT_ALLOWED', message: 'No' } }));
    const error = await failure(sdk(api).createLink('/admin/users'));
    expect(error).toBeInstanceOf(RouteNotAllowedError);
    expect(error.kind).toBe('route_not_allowed');
    expect(error.name).toBe('RouteNotAllowedError');
    expect((error as RouteNotAllowedError).routePath).toBe('/admin/users');
    expect(api.calls).toHaveLength(1);
  });

  it('maps 429 to RateLimited with retryAfter from the header, without retrying', async () => {
    const api = new Api(() =>
      json(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '60' }),
    );
    const error = await failure(sdk(api).createLink('/product/42'));
    expect(error).toBeInstanceOf(StrybokRateLimitedError);
    expect(error.kind).toBe('rate_limited');
    expect(error.name).toBe('StrybokRateLimitedError');
    expect((error as StrybokRateLimitedError).retryAfterSeconds).toBe(60);
    expect(api.calls).toHaveLength(1);
  });

  it('reads Retry-After as seconds or as an HTTP date', async () => {
    const now = Date.parse('2026-11-24T23:59:00Z');
    const cases: [string, number | undefined][] = [
      ['0', 0],
      [' 86400 ', 86400],
      ['Wed, 25 Nov 2026 00:00:00 GMT', 60],
      ['Tue, 24 Nov 2026 23:58:00 GMT', 0], // Already over.
      ['soon', undefined],
      ['-5', undefined],
      ['1.5', undefined],
      ['', undefined],
    ];
    for (const [header, expected] of cases) {
      const api = new Api(() => json(429, {}, { 'Retry-After': header }));
      const error = await failure(sdk(api, { now: () => now }).createLink('/product/42'));
      expect((error as StrybokRateLimitedError).retryAfterSeconds, header).toBe(expected);
    }
  });

  it('maps 429 to RateLimited without retryAfter when there is no usable header', async () => {
    const answers: FetchResponseLike[] = [
      json(429, {}), // A transport that exposes no headers at all.
      json(429, {}, {}),
      { ...response(429), headers: null },
      { ...response(429), headers: { get: () => undefined } },
      {
        ...response(429),
        headers: {
          get: () => {
            throw new Error('broken transport');
          },
        },
      },
    ];
    for (const answer of answers) {
      const api = new Api(() => answer);
      const error = await failure(sdk(api).createLink('/product/42'));
      expect(error).toBeInstanceOf(StrybokRateLimitedError);
      expect((error as StrybokRateLimitedError).retryAfterSeconds).toBeUndefined();
      expect(api.calls).toHaveLength(1);
    }
  });

  it('maps 400, 413 and 422 to Validation with the message and issues of the service', async () => {
    for (const status of [400, 413, 422]) {
      const api = new Api(() =>
        json(status, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: {
              issues: [
                { path: 'title', message: 'Too long' },
                { path: 'imageUrl', message: 'Must be an HTTPS URL', code: 'custom' },
                { path: 7, message: 'dropped: path is not a string' },
                'dropped: not an object',
                null,
              ],
            },
          },
        }),
      );
      const error = (await failure(sdk(api).createLink('/product/42'))) as StrybokValidationError;
      expect(error).toBeInstanceOf(StrybokValidationError);
      expect(error.kind).toBe('validation');
      expect(error.statusCode).toBe(status);
      expect(error.message).toBe('Request validation failed');
      expect(error.issues).toEqual([
        { path: 'title', message: 'Too long' },
        { path: 'imageUrl', message: 'Must be an HTTPS URL' },
      ]);
      expect(api.calls).toHaveLength(1);
    }
  });

  it('maps 400, 413 and 422 to Validation when the body says nothing', async () => {
    for (const body of [
      '',
      '<html>413 Request Entity Too Large</html>',
      'null',
      '[]',
      JSON.stringify({ error: 'text' }),
      JSON.stringify({ error: { message: 42, details: { issues: 'none' } } }),
      JSON.stringify({ error: { details: null } }),
    ]) {
      const api = new Api(() => response(413, body));
      const error = (await failure(sdk(api).createLink('/product/42'))) as StrybokValidationError;
      expect(error, body).toBeInstanceOf(StrybokValidationError);
      expect(error.statusCode).toBe(413);
      expect(error.message).toBe('The service rejected the link (status 413)');
      expect(error.issues).toEqual([]);
      expect(api.calls).toHaveLength(1);
    }
  });

  it('maps any other 4xx to Server without retrying', async () => {
    for (const status of [402, 404, 405, 409, 410, 415, 418, 451]) {
      const api = new Api(() => response(status, 'nope'));
      const error = await failure(sdk(api).createLink('/product/42'));
      expect(error, String(status)).toBeInstanceOf(StrybokServerError);
      expect((error as StrybokServerError).statusCode).toBe(status);
      expect(api.calls).toHaveLength(1);
    }
  });

  it('maps any other status below 500 to Server without retrying', async () => {
    for (const status of [202, 204, 301, 304]) {
      const api = new Api(() => json(status, created));
      const error = await failure(sdk(api).createLink('/product/42'));
      expect(error, String(status)).toBeInstanceOf(StrybokServerError);
      expect((error as StrybokServerError).statusCode).toBe(status);
      expect(api.calls).toHaveLength(1);
    }
  });
});

describe('createLink: timeout and retries', () => {
  it('retries 5xx and reports Server with the last status after maxRetries extra attempts', async () => {
    const api = new Api((attempt) => response(attempt === 3 ? 503 : 500, 'down'));
    const error = await failure(sdk(api).createLink('/product/42'));
    expect(error).toBeInstanceOf(StrybokServerError);
    expect((error as StrybokServerError).statusCode).toBe(503);
    expect(api.calls).toHaveLength(3);
  });

  it('returns the link when a retry after 5xx succeeds', async () => {
    const api = new Api((attempt) => (attempt < 3 ? response(502) : json(200, created)));
    expect(await sdk(api).createLink('/product/42')).toEqual(created);
    expect(api.calls).toHaveLength(3);
  });

  it('retries transport failures and reports Network', async () => {
    const api = new Api(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await failure(sdk(api).createLink('/product/42'));
    expect(error).toBeInstanceOf(StrybokNetworkError);
    expect(error.kind).toBe('network');
    expect(api.calls).toHaveLength(3);
  });

  it('retries a body that cannot be read as a transport failure', async () => {
    const api = new Api((attempt) =>
      attempt === 1
        ? { status: 201, text: () => Promise.reject(new Error('connection reset')) }
        : json(201, created),
    );
    expect(await sdk(api).createLink('/product/42')).toEqual(created);
    expect(api.calls).toHaveLength(2);
  });

  it('retries when there is no answer in time and reports Timeout', async () => {
    const api = new Api(() => never());
    const error = await failure(sdk(api, { timeoutMs: 15 }).createLink('/product/42'));
    expect(error).toBeInstanceOf(StrybokTimeoutError);
    expect(error.kind).toBe('timeout');
    expect(error.message).toBe('The create link request timed out');
    expect(api.calls).toHaveLength(3);
  });

  it('aborts the request that timed out', async () => {
    const api = new Api(() => never());
    await failure(sdk(api, { timeoutMs: 15, maxRetries: 0 }).createLink('/product/42'));
    expect((api.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  });

  it('returns the link when a retry after a timeout succeeds', async () => {
    const api = new Api((attempt) => (attempt === 1 ? never() : json(201, created)));
    expect(await sdk(api, { timeoutMs: 15 }).createLink('/product/42')).toEqual(created);
    expect(api.calls).toHaveLength(2);
  });

  it('reports the last error when the attempts fail differently', async () => {
    const api = new Api((attempt) =>
      attempt === 1 ? response(500) : Promise.reject(new Error('offline')),
    );
    const error = await failure(sdk(api).createLink('/product/42'));
    expect(error).toBeInstanceOf(StrybokNetworkError);
    expect(api.calls).toHaveLength(3);
  });

  it('makes exactly maxRetries extra attempts', async () => {
    for (const maxRetries of [0, 1, 4]) {
      const api = new Api(() => response(500));
      await failure(sdk(api, { maxRetries }).createLink('/product/42'));
      expect(api.calls).toHaveLength(maxRetries + 1);
    }
  });

  it('waits retryDelay before the first retry and doubles it each time', async () => {
    const times: number[] = [];
    const api = new Api(() => {
      times.push(performance.now());
      return response(500);
    });
    await failure(sdk(api, { retryDelayMs: 40, maxRetries: 2 }).createLink('/product/42'));
    expect(times).toHaveLength(3);
    const [first, second, third] = times as [number, number, number];
    // Timers may fire a little early; lower bounds only, so a slow machine cannot fail this.
    expect(second - first).toBeGreaterThanOrEqual(35);
    expect(third - second).toBeGreaterThanOrEqual(75);
  });

  it('sends exactly the same request on every retry', async () => {
    const api = new Api((attempt) => (attempt < 3 ? response(500) : json(201, created)));
    const payload: Record<string, unknown> = {
      productId: 42,
      tags: ['a', 'b'],
      nested: { z: 1, a: 2 },
    };
    const pending = sdk(api, { retryDelayMs: 20 }).createLink('/product/42', {
      payload,
      title: 'Red shoes',
    });
    // The app changes its object while the SDK is still retrying.
    await settle(5);
    payload['productId'] = 43;
    delete payload['tags'];
    await pending;

    expect(api.calls).toHaveLength(3);
    const [first, second, third] = api.calls as [Call, Call, Call];
    expect(first.init.body).toBe(
      '{"routePath":"/product/42","payload":{"productId":42,"tags":["a","b"],"nested":{"z":1,"a":2}},"title":"Red shoes"}',
    );
    expect(second.init.body).toBe(first.init.body);
    expect(third.init.body).toBe(first.init.body);
    for (const call of [second, third]) {
      expect(call.url).toBe(first.url);
      expect(call.init.method).toBe(first.init.method);
      expect(call.init.headers).toEqual(first.init.headers);
    }
  });

  it('never retries 4xx answers, including 429', async () => {
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      const api = new Api(() => response(status));
      await failure(sdk(api, { maxRetries: 5 }).createLink('/product/42'));
      expect(api.calls, String(status)).toHaveLength(1);
    }
  });
});

describe('createLink: errors', () => {
  it('never contain the client key or the payload', async () => {
    const options: CreateLinkOptions = {
      payload: { secret: secretValue },
      title: 'Red shoes',
    };
    // A transport error that drags the whole request along, as HTTP clients often do.
    const transportError = (init: FetchRequestInit) =>
      Object.assign(new Error(`Request failed: ${init.body} ${init.headers['X-Strybok-Key']}`), {
        config: init,
      });
    const scenarios: [string, Partial<StrybokOptions>, (api: Api) => void][] = [
      ['401', {}, (api) => (api.answer = () => response(401))],
      ['403', {}, (api) => (api.answer = () => response(403))],
      ['429', {}, (api) => (api.answer = () => json(429, {}, { 'Retry-After': '5' }))],
      ['422', {}, (api) => (api.answer = () => json(422, { error: { message: 'Invalid' } }))],
      ['404', {}, (api) => (api.answer = () => response(404))],
      ['500', {}, (api) => (api.answer = () => response(500))],
      ['malformed', {}, (api) => (api.answer = () => response(201, '{}'))],
      ['timeout', { timeoutMs: 10 }, (api) => (api.answer = () => never())],
      [
        'network',
        {},
        (api) =>
          (api.answer = () =>
            Promise.reject(transportError(api.calls[api.calls.length - 1]!.init))),
      ],
    ];
    for (const [name, sdkOptions, arrange] of scenarios) {
      const api = new Api();
      arrange(api);
      const error = await failure(sdk(api, sdkOptions).createLink('/product/42', options));
      expect(api.calls.length, name).toBeGreaterThan(0);
      const text = dump(error);
      expect(text, name).not.toContain(clientKey);
      expect(text, name).not.toContain(secretValue);
      expect(error.url, name).toBeUndefined();
    }

    // The checks before the request, too.
    const api = new Api();
    for (const error of [
      await failure(sdk(api).createLink(`//${secretValue}`, options)),
      await failure(
        sdk(api).createLink('/product/42', {
          payload: [secretValue],
        } as unknown as CreateLinkOptions),
      ),
    ]) {
      expect(dump(error)).not.toContain(clientKey);
      expect(dump(error)).not.toContain(secretValue);
    }
    expect(api.calls).toHaveLength(0);
  });

  it('does not attach what the transport threw to a Network error', async () => {
    const api = new Api(() => Promise.reject(new Error('offline')));
    const error = await failure(sdk(api, { maxRetries: 0 }).createLink('/product/42'));
    expect((error as StrybokNetworkError).cause).toBeUndefined();
  });

  it('are thrown to the caller and never passed to onError', async () => {
    const errors: StrybokError[] = [];
    const onError = (error: StrybokError) => errors.push(error);
    for (const answer of [
      () => response(401),
      () => response(403),
      () => response(429),
      () => response(422),
      () => response(500),
      () => Promise.reject(new Error('offline')),
    ]) {
      await failure(sdk(new Api(answer), { onError }).createLink('/product/42'));
    }
    await failure(sdk(new Api(), { onError, clientKey: undefined }).createLink('/product/42'));
    await failure(sdk(new Api(), { onError }).createLink('nope'));
    await settle();
    expect(errors).toEqual([]);
  });
});

describe('createLink: independent of the start path', () => {
  it('works without initialize and does not start the SDK', async () => {
    const source = new FakeLinkSource({ initialUrl: invite });
    const api = new Api();
    const strybok = sdk(api, { linkSource: source });
    expect(await strybok.createLink('/product/42')).toEqual(created);
    await settle();
    expect(source.hasListener).toBe(false);
    expect(api.calls.map((call) => call.url)).toEqual([`${apiBaseUrl}/v1/public/links`]);
  });

  it('does not need allowedHosts', async () => {
    const api = new Api();
    expect(await sdk(api, { allowedHosts: [] }).createLink('/product/42')).toEqual(created);
  });

  it('is never called by initialize, resolving or delivery', async () => {
    const urls: string[] = [];
    const source = new FakeLinkSource({ initialUrl: invite });
    const strybok = new Strybok({
      apiBaseUrl,
      allowedHosts: [host],
      linkSource: source,
      clientKey,
      fetch: (url, init) => {
        urls.push(url);
        expect(init.headers['X-Strybok-Key']).toBeUndefined();
        return Promise.resolve(
          url.endsWith('/v1/public/events')
            ? response(202)
            : json(200, { linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' }),
        );
      },
    });
    onTestFinished(() => strybok.dispose());
    const routes: string[] = [];
    strybok.onLink((link) => routes.push(link.routePath));
    await strybok.initialize();
    source.emit(`https://${host}/other`);
    await strybok.resolveUrl(invite);
    await settle();

    expect(routes).toEqual(['/invite/abc123', '/invite/abc123']);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => url.includes('/v1/public/links'))).toEqual([]);
  });

  it('does not make initialize wait for a link that is still being created', async () => {
    const source = new FakeLinkSource({ initialUrl: invite });
    const strybok = new Strybok({
      apiBaseUrl,
      allowedHosts: [host],
      linkSource: source,
      clientKey,
      reportAppOpens: false,
      timeoutMs: 80,
      maxRetries: 0,
      fetch: (url) =>
        url.endsWith('/v1/public/links')
          ? never()
          : Promise.resolve(
              json(200, { linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' }),
            ),
    });
    onTestFinished(() => strybok.dispose());
    const creating = failure(strybok.createLink('/product/42'));
    await strybok.initialize();
    expect((await strybok.getInitialLink())?.routePath).toBe('/invite/abc123');
    expect(await creating).toBeInstanceOf(StrybokTimeoutError);
  });

  it('does not affect link delivery when it fails', async () => {
    const source = new FakeLinkSource();
    const errors: StrybokError[] = [];
    const strybok = new Strybok({
      apiBaseUrl,
      allowedHosts: [host],
      linkSource: source,
      clientKey,
      reportAppOpens: false,
      onError: (error) => errors.push(error),
      fetch: (url) =>
        Promise.resolve(
          url.endsWith('/v1/public/links')
            ? response(401)
            : json(200, { linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' }),
        ),
    });
    onTestFinished(() => strybok.dispose());
    const routes: string[] = [];
    strybok.onLink((link) => routes.push(link.routePath));
    await strybok.initialize();
    await failure(strybok.createLink('/product/42'));
    source.emit(invite);
    await settle();
    expect(routes).toEqual(['/invite/abc123']);
    expect(errors).toEqual([]);
  });

  it('runs concurrent calls independently', async () => {
    const api = new Api();
    api.answer = (attempt) => {
      const { routePath } = JSON.parse(api.calls[attempt - 1]!.init.body!) as { routePath: string };
      return json(201, { ...created, routePath, slug: routePath.slice(1) });
    };
    const strybok = sdk(api);
    const links = await Promise.all(['/a', '/b', '/c'].map((route) => strybok.createLink(route)));
    expect(links.map((link) => link.slug)).toEqual(['a', 'b', 'c']);
  });

  it('rejects with a plain Error after dispose, without a network call', async () => {
    const api = new Api();
    const strybok = sdk(api);
    strybok.dispose();
    const error = await strybok.createLink('/product/42').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StrybokError);
    expect(api.calls).toHaveLength(0);
  });

  it('is cancelled by dispose while in flight', async () => {
    const api = new Api(() => never());
    const strybok = sdk(api, { timeoutMs: 5000 });
    const pending = strybok.createLink('/product/42').catch((e: unknown) => e);
    await settle(5);
    strybok.dispose();
    expect((api.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    api.answer = () => json(201, created);
    // Nothing settles the transport here; a real one rejects on abort.
    const outcome = await Promise.race([pending, settle(30).then(() => 'pending')]);
    expect(outcome).toBe('pending');
  });
});
