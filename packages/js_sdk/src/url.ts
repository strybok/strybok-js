/**
 * A small, strict URL parser.
 *
 * The SDK decides from a URL whether a link belongs to the app, so two parsers disagreeing about
 * where the host ends is a security problem, and the WHATWG `URL` class is not complete in every
 * runtime this code targets (React Native's has historically been partial). This parser therefore
 * depends on nothing but string operations, performs no normalisation (no percent-decoding, no
 * dot-segment removal, no backslash fixing, no whitespace trimming) and rejects whatever it does
 * not fully understand.
 */
export interface ParsedUrl {
  /** Lower-cased, without the colon. */
  readonly scheme: string;
  /** Text before `@` in the authority, or `null` when there is no `@`. */
  readonly userInfo: string | null;
  /** Lower-cased. IPv6 literals keep their brackets. */
  readonly host: string;
  /** `null` when the URL has no port. */
  readonly port: number | null;
  /** Raw path, exactly as written; empty when the URL has none. */
  readonly path: string;
  /** Raw text after `?`, or `null`. */
  readonly query: string | null;
  /** Raw text after `#`, or `null`. */
  readonly fragment: string | null;
}

/** Longer inputs are rejected outright; real links are a few dozen characters. */
export const MAX_URL_LENGTH = 8192;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
// ASCII only, checked before lower-casing: 'K' (U+212A KELVIN SIGN) lower-cases to a plain 'k'.
const REG_NAME = /^[A-Za-z0-9._-]+$/;
const IPV6_LITERAL = /^\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\]$/;
const PORT = /^[0-9]{1,5}$/;
const SLUG_PATH = /^\/[A-Za-z0-9_-]{1,64}$/;
/** The campaign parameters, in the order they are sent. */
const CAMPAIGN_QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;
const CAMPAIGN_VALUE = /^[A-Za-z0-9._~-]{1,64}$/;

// Links without an API call (the `parameterLinks` option): path links and Firebase long links.
/** 1–512 characters of the URL path alphabet, as received; escapes are checked separately. */
const ROUTE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,511}$/;
const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const ENCODED_DOT = /%2e/gi;
/** Never a route, nor anything under them. */
const RESERVED_TREES: readonly string[] = ['/.well-known', '/_strybok'];
/** Asked for by browsers and crawlers on their own: never a route. */
const RESERVED_FILES: readonly string[] = [
  '/favicon.ico',
  '/robots.txt',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/sitemap.xml',
  '/ads.txt',
  '/app-ads.txt',
  '/security.txt',
  '/humans.txt',
  '/manifest.json',
  '/site.webmanifest',
  '/browserconfig.xml',
];
/** Of a long link only these are read; `link` makes a root URL a long link. */
const LONG_LINK_KEYS: readonly string[] = ['link', 'apn', 'ibi'];
/**
 * `scheme://host` and the rest (any characters: `.` would stop at U+2028); the scheme is checked
 * to be http(s), the rest to start right.
 */
const DEEP_LINK = /^([A-Za-z]+):\/\/([A-Za-z0-9._-]+)([\s\S]*)$/;
const MAX_PAYLOAD_VALUE_LENGTH = 256;

/** Parses an absolute hierarchical URL (`scheme://authority...`), or returns `null`. */
export function parseUrl(input: unknown): ParsedUrl | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) return null;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // Whitespace and control characters: other parsers trim or strip them, we refuse.
    if (code <= 0x20 || code === 0x7f) return null;
  }

  const schemeMatch = SCHEME.exec(input);
  if (schemeMatch === null) return null;
  const scheme = (schemeMatch[1] as string).toLowerCase();
  const rest = input.slice(schemeMatch[0].length);

  const authorityEnd = firstIndexOfAny(rest, '/?#');
  const authority = rest.slice(0, authorityEnd);
  const afterAuthority = rest.slice(authorityEnd);

  // Browsers read a backslash as a slash for http(s), which moves the end of the host; we do
  // not guess which reading the sender meant.
  if (authority.includes('\\')) return null;

  const at = authority.lastIndexOf('@');
  const userInfo = at >= 0 ? authority.slice(0, at) : null;
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;

  let rawHost: string;
  let rawPort: string | null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return null;
    rawHost = hostPort.slice(0, close + 1);
    const tail = hostPort.slice(close + 1);
    if (tail === '') rawPort = null;
    else if (tail.startsWith(':')) rawPort = tail.slice(1);
    else return null;
    if (!IPV6_LITERAL.test(rawHost)) return null;
  } else {
    const colon = hostPort.indexOf(':');
    rawHost = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    rawPort = colon >= 0 ? hostPort.slice(colon + 1) : null;
    if (!REG_NAME.test(rawHost)) return null;
  }

  let port: number | null = null;
  if (rawPort !== null) {
    if (!PORT.test(rawPort)) return null; // Also refuses an empty port ("host:").
    port = Number(rawPort);
    if (port > 65535) return null;
  }

  const hash = afterAuthority.indexOf('#');
  const fragment = hash >= 0 ? afterAuthority.slice(hash + 1) : null;
  const beforeFragment = hash >= 0 ? afterAuthority.slice(0, hash) : afterAuthority;
  const mark = beforeFragment.indexOf('?');
  const query = mark >= 0 ? beforeFragment.slice(mark + 1) : null;
  const path = mark >= 0 ? beforeFragment.slice(0, mark) : beforeFragment;
  if (path.includes('\\')) return null;

  return { scheme, userInfo, host: rawHost.toLowerCase(), port, path, query, fragment };
}

/** A URL that passed every rule of the SDK contract. */
export interface StrybokLinkParts {
  /** Lower-cased hostname. */
  readonly host: string;
  /**
   * The path as received: `/` followed by the slug or, with `parameterLinks`, a route path (`/`
   * for an empty one, and for a Firebase long link).
   */
  readonly path: string;
  /**
   * What is sent to the API: `https://{host}{path}`, followed by the payload query
   * ({@link payloadQuery}, only with `parameterLinks`) and the campaign query
   * ({@link campaignQuery}) when there is anything to send; for a long link `link`, `apn` and
   * `ibi` take the place of the payload query. Never the rest of the query or the fragment.
   */
  readonly lookupUrl: string;
}

/**
 * Applies the contract's "which URLs are ours" rules: `https`, a host from `allowedHosts`
 * (already lower-cased), no user info, no port or port 443, and a path of exactly one slug.
 *
 * With `payloadKeys` (the validated `parameterLinks` option, which may be an empty list) also a
 * route path or a Firebase long link, as "Links without an API call" says. `null` (the default)
 * is the option not set: then only a slug is ours and the lookup is exactly what 0.3.0 sent.
 */
export function parseStrybokLink(
  input: unknown,
  allowedHosts: ReadonlySet<string>,
  payloadKeys: readonly string[] | null = null,
): StrybokLinkParts | null {
  const url = parseUrl(input);
  if (url === null) return null;
  if (url.scheme !== 'https') return null;
  if (url.userInfo !== null) return null;
  if (url.port !== null && url.port !== 443) return null;
  if (!allowedHosts.has(url.host)) return null;
  const campaign = campaignQuery(url.query);
  if (payloadKeys === null) {
    if (!SLUG_PATH.test(url.path)) return null;
    return linkParts(url.host, url.path, [campaign]);
  }

  // In this order: a slug, an empty path read as `/`, a long link at `/`, a route path.
  if (SLUG_PATH.test(url.path)) {
    return linkParts(url.host, url.path, [payloadQuery(url.query, payloadKeys), campaign]);
  }
  const path = url.path === '' ? '/' : url.path;
  if (path === '/') {
    const longLink = longLinkQuery(url.query, payloadKeys);
    if (longLink === null) return null;
    if (longLink !== undefined) return linkParts(url.host, path, [longLink, campaign]);
  }
  if (!isRoutePath(path)) return null;
  return linkParts(url.host, path, [payloadQuery(url.query, payloadKeys), campaign]);
}

/** `lookupUrl` from its parts; the query is left out when no part has anything in it. */
function linkParts(host: string, path: string, queries: readonly string[]): StrybokLinkParts {
  const query = queries.filter((part) => part !== '').join('&');
  return { host, path, lookupUrl: `https://${host}${path}${query === '' ? '' : `?${query}`}` };
}

/**
 * The contract's "campaign query": what of a tapped URL's raw query string (the text after `?`)
 * is sent to the API. Empty when nothing is.
 *
 * Only the five `utm_*` keys are kept, compared exactly after decoding; of each the first
 * occurrence counts, and it is dropped unless its decoded value is 1–64 characters of
 * `A-Z a-z 0-9 . _ ~ -`. The result is `key=value` pairs joined with `&` in a fixed order; such
 * values never need encoding. Every other parameter may hold private data and is never returned.
 */
export function campaignQuery(query: string | null): string {
  const first = firstOccurrences(query, CAMPAIGN_QUERY_KEYS);
  const kept: string[] = [];
  for (const key of CAMPAIGN_QUERY_KEYS) {
    const value = first.get(key);
    if (typeof value === 'string' && CAMPAIGN_VALUE.test(value)) kept.push(`${key}=${value}`);
  }
  return kept.join('&');
}

/**
 * The contract's "payload query" of a raw query string: for each of `payloadKeys`, in that
 * order, its first occurrence (split and decoded like the campaign query), kept when the decoded
 * value is 1–256 UTF-16 code units without a character in U+0000–U+001F or U+007F–U+009F, and
 * written with {@link encodeValue}. A first occurrence that cannot be decoded or breaks these
 * rules drops the key; a later one never counts. Empty when nothing is kept.
 */
export function payloadQuery(query: string | null, payloadKeys: readonly string[]): string {
  if (payloadKeys.length === 0) return '';
  const first = firstOccurrences(query, payloadKeys);
  const kept: string[] = [];
  for (const key of payloadKeys) {
    const value = first.get(key);
    if (typeof value !== 'string' || !isPayloadValue(value)) continue;
    const encoded = encodeValue(value);
    // Keys are 1-40 characters of `A-Z a-z 0-9 _ . -` (checked with the option): no encoding.
    if (encoded !== null) kept.push(`${key}=${encoded}`);
  }
  return kept.join('&');
}

function isPayloadValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PAYLOAD_VALUE_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * What a URL at `/` sends as a Firebase long link: `link={deep}`, then `apn` and `ibi` when the
 * query has them. `undefined` when the query has no `link` parameter (the URL is then no long
 * link), `null` when it has one but the URL is not ours.
 */
function longLinkQuery(
  query: string | null,
  payloadKeys: readonly string[],
): string | null | undefined {
  const first = firstOccurrences(query, LONG_LINK_KEYS);
  const link = first.get('link');
  if (link === undefined) return undefined;
  const deep = link === null ? null : deepLink(link, payloadKeys);
  if (deep === null) return null;
  const pairs = [`link=${deep}`];
  for (const key of ['apn', 'ibi']) {
    const value = first.get(key);
    if (value === undefined) continue;
    // Sent as they are, even empty: the server compares them with the app's identifiers.
    const encoded = value === null ? null : encodeValue(value);
    if (encoded === null) return null;
    pairs.push(`${key}=${encoded}`);
  }
  return pairs.join('&');
}

/**
 * The decoded `link` of a long link, rebuilt and encoded as `deep`: `{scheme}://{host}{path}`
 * with scheme and host lower-cased (`/` for an empty path), followed by the payload query of its
 * own query, without its fragment. `null` when it is not a deep link: `http(s)://` and a host of
 * `A-Z a-z 0-9 . - _` (so no user info, port or IP literal) followed by nothing or a path, query
 * or fragment, with no character up to U+0020, no U+007F and no backslash anywhere.
 */
function deepLink(value: string, payloadKeys: readonly string[]): string | null {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }
  const match = DEEP_LINK.exec(value);
  if (match === null) return null;
  const scheme = (match[1] as string).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  // The host ends at the first character that cannot be in it: it must start the path, the
  // query or the fragment; `:` (a port) and `@` (user info) cannot.
  const rest = match[3] as string;
  if (rest !== '' && !'/?#'.includes(rest.charAt(0))) return null;
  const hash = rest.indexOf('#');
  const beforeFragment = hash >= 0 ? rest.slice(0, hash) : rest;
  const mark = beforeFragment.indexOf('?');
  const path = mark >= 0 ? beforeFragment.slice(0, mark) : beforeFragment;
  const payload = payloadQuery(mark >= 0 ? beforeFragment.slice(mark + 1) : null, payloadKeys);
  const host = (match[2] as string).toLowerCase();
  return encodeValue(
    `${scheme}://${host}${path === '' ? '/' : path}${payload === '' ? '' : `?${payload}`}`,
  );
}

/**
 * Whether a path (as received, never decoded) is a route path: 1–512 characters of the URL path
 * alphabet starting with `/`, every `%` starting an escape, no `//`, no `.` or `..` segment (with
 * `%2e` read as `.`), and nothing reserved for browsers, crawlers and Strybok itself.
 */
function isRoutePath(path: string): boolean {
  if (!ROUTE_PATH.test(path) || MALFORMED_ESCAPE.test(path) || path.includes('//')) return false;
  for (const segment of path.split('/')) {
    const dots = segment.replace(ENCODED_DOT, '.');
    if (dots === '.' || dots === '..') return false;
  }
  if (RESERVED_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`))) return false;
  return !RESERVED_FILES.includes(path);
}

/**
 * The encoding of payload values, `deep`, `apn` and `ibi`: the UTF-8 bytes, every byte outside
 * `A-Z a-z 0-9 - . _ ~` as `%XX` with upper-case digits (so a space is `%20` and `+` is `%2B`).
 * `null` for text with a lone surrogate, which has no UTF-8 form: such a value counts as one that
 * cannot be decoded.
 */
function encodeValue(text: string): string | null {
  let encoded: string;
  try {
    encoded = encodeURIComponent(text);
  } catch {
    return null;
  }
  // The only characters encodeURIComponent leaves alone besides the unreserved ones.
  return encoded.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The decoded value of the first parameter named `name` in a raw query string, parsed like the
 * campaign query. `null` when there is none, or when it cannot be decoded.
 */
export function firstQueryValue(query: string | null, name: string): string | null {
  return firstOccurrences(query, [name]).get(name) ?? null;
}

/**
 * The first occurrence of each of `names` in a raw query string: split on `&`, each part on its
 * first `=`, key and value decoded with {@link decodeQueryComponent} (a part without `=` has an
 * empty value). Maps a name to its decoded value, or to `null` when that value cannot be decoded
 * (it still is the first occurrence); names that do not occur are absent. A key that cannot be
 * decoded is no name's occurrence.
 */
function firstOccurrences(
  query: string | null,
  names: readonly string[],
): Map<string, string | null> {
  const first = new Map<string, string | null>();
  if (query === null || query === '') return first;
  for (const part of query.split('&')) {
    const equals = part.indexOf('=');
    const key = decodeQueryComponent(equals >= 0 ? part.slice(0, equals) : part);
    if (key === null || first.has(key) || !names.includes(key)) continue;
    first.set(key, equals >= 0 ? decodeQueryComponent(part.slice(equals + 1)) : '');
  }
  return first;
}

/**
 * Percent-decodes as UTF-8 with `+` as a space, like `URLSearchParams`. `null` for a malformed
 * escape or invalid UTF-8, which that class would turn into replacement characters: no key or
 * campaign value of ours can be such text, and a payload value is dropped (the contract lets the
 * SDK send less than a browser visit would, never more).
 */
function decodeQueryComponent(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Whether `host` is a bare DNS hostname, as `allowedHosts` entries must be. */
export function isHostname(host: string): boolean {
  return REG_NAME.test(host);
}

function firstIndexOfAny(text: string, chars: string): number {
  for (let i = 0; i < text.length; i++) {
    if (chars.includes(text.charAt(i))) return i;
  }
  return text.length;
}
