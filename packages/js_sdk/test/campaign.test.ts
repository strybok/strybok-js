// Campaign values (SDK contract, "Campaign query"): what of a tapped URL's query is sent to
// resolve, what the resolved link carries, and what `app_open` reports.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type LinkCampaign, type ResolvedLink, StrybokServerError } from '../src/index.js';
import { FakeLinkSource } from '../src/testing.js';
import { Api, apiBaseUrl, bridge, host, invite, response, settle } from './helpers.js';

const resolved = (extra: Record<string, unknown> = {}) =>
  response(200, JSON.stringify({ linkId: 'link_1', appId: 'app_1', routePath: '/x', ...extra }));

const resolveUrlFor = (lookup: string) =>
  `${apiBaseUrl}/v1/public/resolve?url=${encodeURIComponent(lookup)}`;

describe('campaign query sent to resolve', () => {
  it('sends the example of the contract exactly as written there', async () => {
    const api = new Api();
    const sdk = bridge(api, { allowedHosts: ['myapp.strybok.link'] });
    const tapped =
      'https://MyApp.strybok.link/invite777?utm_source=instagram&fbclid=abc&utm_medium=two%20words&utm_source=x#top';
    const link = await sdk.resolveUrl(tapped);

    expect(link.url).toBe(tapped);
    expect(api.resolves).toHaveLength(1);
    const request = api.resolves[0]!;
    expect(request.query).toEqual({
      url: 'https://myapp.strybok.link/invite777?utm_source=instagram',
    });
    expect(request.url).toBe(
      `${apiBaseUrl}/v1/public/resolve?url=https%3A%2F%2Fmyapp.strybok.link%2Finvite777%3Futm_source%3Dinstagram`,
    );
  });

  it('sends all five values in the fixed order and nothing else of the URL', async () => {
    const api = new Api();
    await bridge(api).resolveUrl(
      `https://${host}/invite777?utm_content=banner&token=secret&utm_term=shoes&email=a%40b.c` +
        '&utm_campaign=spring_sale&gclid=G1&utm_medium=social&utm_id=7&utm_source=instagram#private',
    );
    const request = api.resolves[0]!;
    expect(request.url).toBe(
      resolveUrlFor(
        `https://${host}/invite777?utm_source=instagram&utm_medium=social` +
          '&utm_campaign=spring_sale&utm_term=shoes&utm_content=banner',
      ),
    );
    // One query parameter only: the campaign values travel inside `url`, encoded.
    expect(Object.keys(request.query)).toEqual(['url']);
    for (const leaked of ['secret', 'token', 'email', 'b.c', 'gclid', 'G1', 'utm_id', 'private']) {
      expect(request.url, leaked).not.toContain(leaked);
    }
  });

  it('drops bad values, takes the first of a repeated key and decodes before checking', async () => {
    const cases: [query: string, sent: string][] = [
      ['utm_source=first&utm_source=second', '?utm_source=first'],
      ['utm_source=two%20words&utm_source=second', ''],
      ['utm_source=a+b&utm_medium=ok', '?utm_medium=ok'],
      ['utm_source=%69nstagram', '?utm_source=instagram'],
      ['utm%5Fsource=instagram', '?utm_source=instagram'],
      ['utm_source=a%40b.c&utm_medium=%D0%B2', ''],
      [`utm_source=${'a'.repeat(64)}`, `?utm_source=${'a'.repeat(64)}`],
      [`utm_source=${'a'.repeat(65)}`, ''],
      ['utm_source=&utm_medium', ''],
      ['UTM_SOURCE=a&Utm_Medium=b', ''],
      ['utm_source=%zz&utm_medium=%', ''],
    ];
    for (const [query, sent] of cases) {
      const api = new Api();
      await bridge(api).resolveUrl(`${invite}?${query}`);
      expect(api.resolves[0]!.url, query).toBe(resolveUrlFor(`${invite}${sent}`));
    }
  });

  it('sends exactly the earlier request when no campaign value is left', async () => {
    const before = `${apiBaseUrl}/v1/public/resolve?url=https%3A%2F%2F${host}%2Finvite777`;
    for (const suffix of [
      '',
      '?',
      '#utm_source=instagram',
      '?token=secret#f',
      '?utm_source=two%20words',
      '?utm_id=1&fbclid=2',
      '?#',
    ]) {
      const api = new Api();
      await bridge(api).resolveUrl(`${invite}${suffix}`);
      const request = api.resolves[0]!;
      expect(request.url, suffix).toBe(before);
      expect(request.init, suffix).toMatchObject({
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      expect(request.init.body).toBeUndefined();
    }
  });

  it('changes nothing else of the request, and retries send the same one', async () => {
    let calls = 0;
    const api = new Api(() => {
      calls++;
      return calls < 3 ? response(503) : resolved();
    });
    await bridge(api).resolveUrl(`${invite}?utm_source=instagram&x=1`);
    expect(api.resolves).toHaveLength(3);
    for (const request of api.resolves) {
      expect(request.url).toBe(resolveUrlFor(`${invite}?utm_source=instagram`));
      expect(request.init.method).toBe('GET');
      expect(request.init.headers).toEqual({ Accept: 'application/json' });
      expect(request.init.body).toBeUndefined();
    }
  });

  it('a query never makes a foreign URL ours, and errors keep the URL as received', async () => {
    const api = new Api(() => response(404));
    const sdk = bridge(api);
    const query = '?utm_source=instagram';
    for (const url of [
      `https://evil.example.com/invite777${query}`,
      `http://${host}/invite777${query}`,
      `https://user@${host}/invite777${query}`,
      `https://${host}:8443/invite777${query}`,
      `https://${host}/a/b${query}`,
      `https://${host}/${query}`,
    ]) {
      expect(sdk.isStrybokUrl(url), url).toBe(false);
      await expect(sdk.resolveUrl(url), url).rejects.toMatchObject({
        kind: 'unsupported_link',
        url,
      });
    }
    expect(api.resolves).toHaveLength(0);

    const tapped = `${invite}?utm_source=instagram&token=secret`;
    await expect(sdk.resolveUrl(tapped)).rejects.toMatchObject({
      kind: 'link_not_found',
      url: tapped,
    });
  });
});

describe('campaign of a resolved link', () => {
  it('is the object the server sent', async () => {
    const api = new Api(() =>
      resolved({ campaign: { source: 'instagram', medium: 'social', campaign: 'spring' } }),
    );
    const link = await bridge(api).resolveUrl(`${invite}?utm_source=instagram`);
    expect(link.campaign).toEqual({ source: 'instagram', medium: 'social', campaign: 'spring' });
    expect(link.campaign.source).toBe('instagram');
    expect(link.campaign.term).toBeUndefined();
    expect('term' in link.campaign).toBe(false);
    expectTypeOf(link.campaign).toEqualTypeOf<LinkCampaign>();
    expectTypeOf<LinkCampaign['source']>().toEqualTypeOf<string | undefined>();
  });

  it('keeps all five fields', async () => {
    const campaign = { source: 'a', medium: 'b', campaign: 'c', term: 'd', content: 'e' };
    const link = await bridge(new Api(() => resolved({ campaign }))).resolveUrl(invite);
    expect(link.campaign).toEqual(campaign);
  });

  it('comes from the answer, not from the URL', async () => {
    const api = new Api(() => resolved({ campaign: { source: 'newsletter' } }));
    const link = await bridge(api).resolveUrl(`${invite}?utm_source=instagram&utm_medium=social`);
    expect(link.campaign).toEqual({ source: 'newsletter' });

    const none = await bridge(new Api(() => resolved())).resolveUrl(
      `${invite}?utm_source=instagram`,
    );
    expect(none.campaign).toEqual({});
  });

  it('is an empty object, never null, when missing or not an object', async () => {
    for (const campaign of [undefined, null, 'instagram', 42, true, [], ['instagram'], {}]) {
      const api = new Api(() => resolved(campaign === undefined ? {} : { campaign }));
      const link = await bridge(api).resolveUrl(invite);
      expect(link.campaign, JSON.stringify(campaign)).toEqual({});
      expect(link.routePath).toBe('/x');
    }
  });

  it('ignores fields that are not strings and keys it does not know', async () => {
    const api = new Api(() =>
      resolved({
        campaign: {
          source: 'instagram',
          medium: 7,
          campaign: null,
          term: { a: 1 },
          content: ['x'],
          id: 'ignored',
          utm_source: 'ignored',
          Source: 'ignored',
        },
      }),
    );
    const link = await bridge(api).resolveUrl(invite);
    expect(link.campaign).toEqual({ source: 'instagram' });
    expect(Object.keys(link.campaign)).toEqual(['source']);
  });

  it('a malformed answer is still an error, with or without campaign', async () => {
    const api = new Api(() =>
      response(200, JSON.stringify({ linkId: 'l', campaign: { source: 'a' } })),
    );
    await expect(bridge(api).resolveUrl(invite)).rejects.toBeInstanceOf(StrybokServerError);
  });

  it('is delivered to listeners and by getInitialLink', async () => {
    const api = new Api(() => resolved({ campaign: { source: 'instagram' } }));
    const source = new FakeLinkSource({ initialUrl: `${invite}?utm_source=instagram` });
    const sdk = bridge(api, { source });
    expect((await sdk.getInitialLink())?.campaign).toEqual({ source: 'instagram' });

    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    source.emit(`https://${host}/other?utm_source=instagram`);
    await settle();
    expect(received.map((link) => link.campaign)).toEqual([{ source: 'instagram' }]);
  });
});

describe('campaign in app_open events', () => {
  async function eventFor(answer: Record<string, unknown>, url = invite) {
    const api = new Api(() => resolved(answer));
    const source = new FakeLinkSource();
    const sdk = bridge(api, { source, platform: 'ios' });
    sdk.onLink(() => {});
    await sdk.initialize();
    source.emit(url);
    await settle();
    expect(api.events).toHaveLength(1);
    return { event: api.events[0]!, request: api.eventRequests[0]! };
  }

  it('reports the campaign exactly as resolve returned it', async () => {
    const { event, request } = await eventFor(
      { campaign: { source: 'instagram', medium: 'social', id: 'x', term: 5 } },
      // The URL says something else: it is never the source of the reported values.
      `${invite}?utm_source=facebook&utm_term=shoes&utm_content=banner`,
    );
    expect(event).toEqual({
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      linkId: 'link_1',
      type: 'app_open',
      platform: 'ios',
      sdkVersion: expect.any(String) as unknown,
      campaign: { source: 'instagram', medium: 'social' },
    });
    expect(request.url).toBe(`${apiBaseUrl}/v1/public/events`);
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('reports all five fields when resolve returned them', async () => {
    const campaign = { source: 'a', medium: 'b', campaign: 'c', term: 'd', content: 'e' };
    const { event } = await eventFor({ campaign });
    expect(event.campaign).toEqual(campaign);
  });

  it('omits campaign when resolve returned none, whatever the URL says', async () => {
    for (const answer of [{}, { campaign: {} }, { campaign: null }, { campaign: { source: 1 } }]) {
      const { event } = await eventFor(answer, `${invite}?utm_source=instagram`);
      expect(Object.keys(event).sort(), JSON.stringify(answer)).toEqual([
        'eventId',
        'linkId',
        'platform',
        'sdkVersion',
        'type',
      ]);
    }
  });
});

describe('duplicates and campaign queries', () => {
  it('the same slug with different campaign values is two links', async () => {
    const api = new Api((request) =>
      resolved({ campaign: { source: request.query.url!.split('utm_source=')[1] ?? 'none' } }),
    );
    const source = new FakeLinkSource();
    const sdk = bridge(api, { source });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    source.emit(`${invite}?utm_source=instagram`);
    source.emit(`${invite}?utm_source=facebook`);
    source.emit(invite);
    await settle();
    expect(received.map((link) => link.campaign.source)).toEqual(['instagram', 'facebook', 'none']);
    expect(api.resolves).toHaveLength(3);
    expect(api.events.map((event) => event.campaign)).toEqual([
      { source: 'instagram' },
      { source: 'facebook' },
      { source: 'none' },
    ]);
  });

  it('compares the URL as received, not the lookup', async () => {
    const api = new Api();
    const source = new FakeLinkSource();
    const sdk = bridge(api, { source });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();

    // The identical string is one tap.
    source.emit(`${invite}?utm_source=instagram&x=1`);
    source.emit(`${invite}?utm_source=instagram&x=1`);
    await settle();
    expect(received).toHaveLength(1);

    // Different strings are different links, even when they send the same lookup.
    source.emit(`${invite}?utm_source=instagram&x=2`);
    source.emit(`${invite}?x=2&utm_source=instagram`);
    await settle();
    expect(received.map((link) => link.url)).toEqual([
      `${invite}?utm_source=instagram&x=1`,
      `${invite}?utm_source=instagram&x=2`,
      `${invite}?x=2&utm_source=instagram`,
    ]);
    expect(new Set(api.resolves.map((request) => request.url)).size).toBe(1);
    expect(api.events).toHaveLength(3);
  });

  it('a launch link replayed on the stream with its query is delivered once', async () => {
    const api = new Api(() => resolved({ campaign: { source: 'instagram' } }));
    const tapped = `${invite}?utm_source=instagram`;
    const source = new FakeLinkSource({ initialUrl: tapped });
    const sdk = bridge(api, { source });
    const received: ResolvedLink[] = [];
    sdk.onLink((link) => received.push(link));
    await sdk.initialize();
    source.emit(tapped);
    await settle();
    expect(received).toHaveLength(1);
    expect(api.resolves).toHaveLength(1);
    expect(api.events).toHaveLength(1);
  });
});
