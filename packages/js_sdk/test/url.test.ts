import { describe, expect, it } from 'vitest';
import { MAX_URL_LENGTH, parseStrybokLink, parseUrl } from '../src/url.js';

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
