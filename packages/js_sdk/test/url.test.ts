import { describe, expect, it } from 'vitest';
import { campaignQuery, MAX_URL_LENGTH, parseStrybokLink, parseUrl } from '../src/url.js';

const host = 'my-app.strybok.link';
const allowed = new Set([host]);
const ours = (url: unknown) => parseStrybokLink(url, allowed);

describe('parseUrl', () => {
  it('splits a full URL into its raw components', () => {
    expect(parseUrl('HTTPS://User:Pw@My-App.Strybok.Link:8443/a/b%2Fc?x=1&y=%20#frag?x')).toEqual({
      scheme: 'https',
      userInfo: 'User:Pw',
      host: 'my-app.strybok.link',
      port: 8443,
      path: '/a/b%2Fc',
      query: 'x=1&y=%20',
      fragment: 'frag?x',
    });
  });

  it('reports absent components as null or empty', () => {
    expect(parseUrl('https://example.com')).toEqual({
      scheme: 'https',
      userInfo: null,
      host: 'example.com',
      port: null,
      path: '',
      query: null,
      fragment: null,
    });
    expect(parseUrl('https://example.com?q')).toMatchObject({ path: '', query: 'q' });
    expect(parseUrl('https://example.com#f')).toMatchObject({ path: '', fragment: 'f' });
    expect(parseUrl('https://example.com/?')).toMatchObject({ path: '/', query: '' });
    expect(parseUrl('https://example.com/#')).toMatchObject({ path: '/', fragment: '' });
    expect(parseUrl('https://@example.com/x')).toMatchObject({ userInfo: '', host: 'example.com' });
  });

  it('does not normalise the path', () => {
    expect(parseUrl('https://example.com/a/../b/./c//d')?.path).toBe('/a/../b/./c//d');
    expect(parseUrl('https://example.com/%41%2f')?.path).toBe('/%41%2f');
  });

  it('uses the last @ to end the user info', () => {
    expect(parseUrl('https://a@b@example.com/x')).toMatchObject({
      userInfo: 'a@b',
      host: 'example.com',
    });
    // An @ after the authority belongs to the path or query, not to user info.
    expect(parseUrl('https://example.com/x@y')).toMatchObject({ userInfo: null, path: '/x@y' });
    expect(parseUrl('https://example.com?u=a@b')).toMatchObject({ userInfo: null, query: 'u=a@b' });
    expect(parseUrl('https://example.com#a@b')).toMatchObject({ userInfo: null, fragment: 'a@b' });
  });

  it('parses ports strictly', () => {
    expect(parseUrl('https://example.com:443/x')?.port).toBe(443);
    expect(parseUrl('https://example.com:0443/x')?.port).toBe(443);
    expect(parseUrl('https://example.com:65535/x')?.port).toBe(65535);
    for (const url of [
      'https://example.com:/x',
      'https://example.com:65536/x',
      'https://example.com:123456/x',
      'https://example.com:44a/x',
      'https://example.com:-1/x',
      'https://example.com:+443/x',
      'https://example.com:4 43/x',
      'https://example.com:443:443/x',
      'https://example.com::443/x',
    ]) {
      expect(parseUrl(url), url).toBeNull();
    }
  });

  it('parses IPv6 literals', () => {
    expect(parseUrl('https://[2001:DB8::1]/x')).toMatchObject({
      host: '[2001:db8::1]',
      port: null,
    });
    expect(parseUrl('https://[::1]:8443/x')).toMatchObject({ host: '[::1]', port: 8443 });
    expect(parseUrl('https://[::ffff:192.0.2.1]/x')?.host).toBe('[::ffff:192.0.2.1]');
    for (const url of [
      'https://[::1/x',
      'https://::1]/x',
      'https://[::1]x/x',
      'https://[::1]:/x',
      'https://[]/x',
      'https://[example.com]/x',
      'https://[::1%25eth0]/x',
      'https://2001:db8::1/x',
    ]) {
      expect(parseUrl(url), url).toBeNull();
    }
  });

  it('rejects input without a scheme and authority', () => {
    for (const url of [
      '',
      'example.com/x',
      'my-app.strybok.link/invite777',
      '//example.com/x',
      '/x',
      'https:/example.com/x',
      'https:example.com/x',
      'https//example.com/x',
      '://example.com/x',
      '1https://example.com/x',
      'ht tps://example.com/x',
      'https:///x',
      'https://',
      'https://?x',
      'https://:443/x',
      'mailto:someone@example.com',
      'javascript:alert(1)',
    ]) {
      expect(parseUrl(url), url).toBeNull();
    }
  });

  it('rejects whitespace and control characters anywhere', () => {
    for (const url of [
      ' https://example.com/x',
      'https://example.com/x ',
      'https://example.com/x\n',
      'https://exa\tmple.com/x',
      'https://example.com/x?a b',
      'https://example.com/x#a\u0000b',
      'https://example.com/\u007fx',
      '\u0000https://example.com/x',
    ]) {
      expect(parseUrl(url), JSON.stringify(url)).toBeNull();
    }
  });

  it('rejects hosts it does not fully understand', () => {
    for (const url of [
      'https://exa mple.com/x',
      'https://example.com\\@evil.example/x',
      'https://example%2Ecom/x',
      'https://ex*mple.com/x',
      'https://éxample.com/x',
      'https://example。com/x',
      'https://stryboK.link/x', // KELVIN SIGN lower-cases to "k"
      'https://example.com\\x',
    ]) {
      expect(parseUrl(url), url).toBeNull();
    }
  });

  it('rejects a backslash in the path but allows it after ? or #', () => {
    expect(parseUrl('https://example.com/a\\b')).toBeNull();
    expect(parseUrl('https://example.com/a?b\\c')?.query).toBe('b\\c');
    expect(parseUrl('https://example.com/a#b\\c')?.fragment).toBe('b\\c');
  });

  it('rejects non-strings and oversized input', () => {
    for (const value of [null, undefined, 42, {}, ['https://example.com/x'], new String('x')]) {
      expect(parseUrl(value)).toBeNull();
    }
    const prefix = 'https://example.com/x?';
    expect(parseUrl(prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length))).not.toBeNull();
    expect(parseUrl(prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length + 1))).toBeNull();
  });
});

describe('parseStrybokLink', () => {
  it('accepts https links on an allowed host with a single slug', () => {
    expect(ours(`https://${host}/invite777`)).toEqual({
      host,
      path: '/invite777',
      lookupUrl: `https://${host}/invite777`,
    });
    expect(ours(`https://${host}/AbC_7-x`)?.path).toBe('/AbC_7-x');
    expect(ours(`https://${host}/${'a'.repeat(64)}`)).not.toBeNull();
    expect(ours(`https://${host}:443/invite777`)?.lookupUrl).toBe(`https://${host}/invite777`);
  });

  it('lower-cases scheme and host but never the slug', () => {
    expect(ours('HTTPS://MY-APP.Strybok.LINK/InVite777')).toEqual({
      host,
      path: '/InVite777',
      lookupUrl: `https://${host}/InVite777`,
    });
  });

  it('ignores query and fragment and keeps them out of the lookup URL', () => {
    for (const suffix of ['?utm=1', '#frag', '?token=secret#f', '?', '#', '?a=/b/c&d=%2F#/x/y']) {
      expect(ours(`https://${host}/abc${suffix}`)?.lookupUrl, suffix).toBe(`https://${host}/abc`);
    }
  });

  it('keeps only the campaign parameters of the query in the lookup URL', () => {
    // The example of the SDK contract, verbatim.
    expect(
      parseStrybokLink(
        'https://MyApp.strybok.link/invite777?utm_source=instagram&fbclid=abc&utm_medium=two%20words&utm_source=x#top',
        new Set(['myapp.strybok.link']),
      ),
    ).toEqual({
      host: 'myapp.strybok.link',
      path: '/invite777',
      lookupUrl: 'https://myapp.strybok.link/invite777?utm_source=instagram',
    });
    expect(
      ours(`https://${host}:443/abc?token=secret&utm_campaign=spring_sale&email=a%40b.c#utm_term=x`)
        ?.lookupUrl,
    ).toBe(`https://${host}/abc?utm_campaign=spring_sale`);
  });

  it('a query string never changes which URLs are accepted', () => {
    const query = '?utm_source=instagram&utm_medium=social';
    expect(ours(`https://${host}/abc${query}`)).not.toBeNull();
    for (const url of [
      `http://${host}/abc`,
      'https://evil.example.com/abc',
      `https://${host}.evil.example.com/abc`,
      `https://user@${host}/abc`,
      `https://user:pw@${host}/abc`,
      `https://${host}:8443/abc`,
      `https://${host}:/abc`,
      `https://${host}/abc/`,
      `https://${host}/abc/def`,
      `https://${host}/a.b`,
      `https://${host}/`,
      `https://${host}`,
      `https://${host}/${'a'.repeat(65)}`,
      `https://${host}\\@evil.example.com/abc`,
    ]) {
      expect(ours(url), url).toBeNull();
      expect(ours(url + query), url + query).toBeNull();
    }
    // What looks like an authority inside the query is only text.
    expect(ours(`https://${host}/abc?utm_source=x@evil.example.com:8443/y`)?.lookupUrl).toBe(
      `https://${host}/abc`,
    );
    expect(ours(`https://evil.example.com/abc?utm_source=${host}`)).toBeNull();
  });

  it('rejects everything else', () => {
    for (const url of [
      // scheme
      `http://${host}/invite777`,
      `myapp://${host}/invite777`,
      `${host}/invite777`,
      `//${host}/invite777`,
      // host
      'https://evil.example.com/invite777',
      `https://${host}.evil.example.com/invite777`,
      `https://evil-${host}/invite777`,
      `https://${host}./invite777`,
      'https://my-app.strybok.link.evil.example/invite777',
      'https://my-app%2Estrybok.link/invite777',
      'https://my-app.stryboK.link/invite777',
      'https://[::1]/invite777',
      // user info
      `https://user:pw@${host}/invite777`,
      `https://user@${host}/invite777`,
      `https://@${host}/invite777`,
      `https://${host}@evil.example.com/invite777`,
      `https://evil.example.com\\@${host}/invite777`,
      `https://evil.example.com%2F@${host}/invite777`,
      // port
      `https://${host}:8443/invite777`,
      `https://${host}:80/invite777`,
      `https://${host}:/invite777`,
      // path
      `https://${host}`,
      `https://${host}/`,
      `https://${host}/invite777/`,
      `https://${host}//invite777`,
      `https://${host}/a/b`,
      `https://${host}/.well-known/assetlinks.json`,
      `https://${host}/a%2Fb`,
      `https://${host}/a%20b`,
      `https://${host}/a.b`,
      `https://${host}/a+b`,
      `https://${host}/a~b`,
      `https://${host}/a;b`,
      `https://${host}/é`,
      `https://${host}/${'a'.repeat(65)}`,
      `https://${host}\\invite777`,
      `https://${host}/invite777\\`,
      `https://${host}?/invite777`,
      `https://${host}#/invite777`,
      // whitespace
      ` https://${host}/invite777`,
      `https://${host}/invite777 `,
      `https://${host}/invite777\n`,
      `https://${host}/invite\t777`,
    ]) {
      expect(ours(url), JSON.stringify(url)).toBeNull();
    }
    for (const value of [null, undefined, 42, {}, [`https://${host}/invite777`]]) {
      expect(ours(value)).toBeNull();
    }
  });

  it('matches IPv6 hosts only when explicitly allowed', () => {
    expect(parseStrybokLink('https://[::1]/abc', new Set(['[::1]']))?.lookupUrl).toBe(
      'https://[::1]/abc',
    );
  });
});

describe('campaignQuery', () => {
  it('is empty when there is no query or nothing of ours in it', () => {
    for (const query of [
      null,
      '',
      '&',
      '&&&',
      '=',
      'utm_source',
      'utm_source=',
      'token=secret',
      'utm=1',
      'utm_id=42&gclid=x&fbclid=y',
      'a=/b/c&d=%2F',
    ]) {
      expect(campaignQuery(query), String(query)).toBe('');
    }
  });

  it('keeps the five keys and nothing else', () => {
    expect(
      campaignQuery(
        'utm_source=instagram&utm_medium=social&utm_campaign=spring&utm_term=shoes&utm_content=banner',
      ),
    ).toBe(
      'utm_source=instagram&utm_medium=social&utm_campaign=spring&utm_term=shoes&utm_content=banner',
    );
    expect(
      campaignQuery('token=secret&utm_source=a&utm_id=7&utm_sourcex=b&xutm_medium=c&gclid=d'),
    ).toBe('utm_source=a');
  });

  it('writes the kept pairs in the fixed order, whatever the order in the URL', () => {
    expect(
      campaignQuery('utm_content=e&x=1&utm_term=d&utm_campaign=c&utm_medium=b&y=2&utm_source=a'),
    ).toBe('utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e');
    expect(campaignQuery('utm_content=e&utm_medium=b')).toBe('utm_medium=b&utm_content=e');
  });

  it('compares key names exactly, in lower case', () => {
    expect(
      campaignQuery('UTM_SOURCE=a&Utm_Medium=b&utm_Campaign=c&utm-term=d&utm_content%20=e'),
    ).toBe('');
    expect(campaignQuery('UTM_SOURCE=a&utm_source=b')).toBe('utm_source=b');
  });

  it('takes the first occurrence of a key, even when its value is dropped', () => {
    expect(campaignQuery('utm_source=first&utm_source=second')).toBe('utm_source=first');
    expect(campaignQuery('utm_source=two%20words&utm_source=second')).toBe('');
    expect(campaignQuery('utm_source=&utm_source=second')).toBe('');
    expect(campaignQuery('utm_source&utm_source=second')).toBe('');
    expect(campaignQuery('utm_source=%zz&utm_source=second')).toBe('');
    expect(campaignQuery('utm_medium=a&utm_source=b&utm_medium=c&utm_source=d')).toBe(
      'utm_source=b&utm_medium=a',
    );
  });

  it('drops values that are empty, too long or outside the allowed characters', () => {
    const allowedCharacters = 'AZaz09._~-';
    expect(campaignQuery(`utm_source=${allowedCharacters}`)).toBe(
      `utm_source=${allowedCharacters}`,
    );
    expect(campaignQuery(`utm_source=${'a'.repeat(64)}`)).toBe(`utm_source=${'a'.repeat(64)}`);
    expect(campaignQuery(`utm_source=${'a'.repeat(65)}`)).toBe('');
    for (const value of [
      '',
      'two%20words',
      'two+words',
      'a%2Bb',
      'a@b.c',
      'a%40b.c',
      'a/b',
      'a%2Fb',
      'a%25b',
      'a%26b',
      'a%3Db',
      'a=b',
      'a,b',
      'a:b',
      'a!b',
      '(other)',
      '%22quoted%22',
      "it's",
      '<b>',
      'caf%C3%A9',
      'caf\u00e9',
      '%D0%B2%D0%B5%D1%81%D0%BD%D0%B0',
      'a%00b',
      'a%0Ab',
      '%',
      '%4',
      '%zz',
      '%FF',
      '%C3',
    ]) {
      expect(campaignQuery(`utm_source=${value}&utm_medium=ok`), value).toBe('utm_medium=ok');
    }
  });

  it('percent-decodes keys and values before checking them', () => {
    expect(campaignQuery('utm_source=%69nstagram')).toBe('utm_source=instagram');
    expect(campaignQuery('utm%5Fsource=a')).toBe('utm_source=a');
    expect(campaignQuery('%75tm_medium=spring%5Fsale%2D1%2E0%7E')).toBe(
      'utm_medium=spring_sale-1.0~',
    );
    // A `+` is a space, in keys too, so neither side can match.
    expect(campaignQuery('utm_source=a+b&utm+medium=c')).toBe('');
    // An encoded separator is part of the value, not a separator.
    expect(campaignQuery('x=1%26utm_source=a')).toBe('');
    expect(campaignQuery('utm_source=a%26utm_medium=b')).toBe('');
    // A key whose own escape is malformed is not one of ours and does not count as a first one.
    expect(campaignQuery('utm_source%zz=a&utm_source=b')).toBe('utm_source=b');
  });

  it('splits each part on its first "=" only', () => {
    expect(campaignQuery('utm_source=a=b&utm_medium=c')).toBe('utm_medium=c');
    expect(campaignQuery('=utm_source&utm_medium=c')).toBe('utm_medium=c');
  });

  it('agrees with URLSearchParams, which the server uses', () => {
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    for (const query of [
      'utm_source=instagram&fbclid=abc&utm_medium=two%20words&utm_source=x',
      'utm_content=e&utm_term=d&utm_campaign=c&utm_medium=b&utm_source=a',
      'utm_source=%zz&utm_source=b&utm_medium=%69',
      'utm_source%zz=a&utm_source=b',
      'utm%5Fsource=a&utm_medium=a+b&utm_campaign=%FF&utm_term&utm_content==',
      '&&utm_source=a=b&=x&utm_medium=~-._',
    ]) {
      const params = new URLSearchParams(query);
      const expected = keys
        .map((key) => [key, params.get(key)] as const)
        .filter(([, value]) => value !== null && /^[A-Za-z0-9._~-]{1,64}$/.test(value))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
      expect(campaignQuery(query), query).toBe(expected);
    }
  });
});
