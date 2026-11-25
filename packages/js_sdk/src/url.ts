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
/** The only query parameters ever sent to the API, in the order they are sent. */
const CAMPAIGN_QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;
const CAMPAIGN_VALUE = /^[A-Za-z0-9._~-]{1,64}$/;

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
  /** `/` followed by the slug. */
  readonly path: string;
  /**
   * What is sent to the API: `https://{host}{path}`, followed by the campaign query
   * ({@link campaignQuery}) when the URL has one. Never the rest of the query or the fragment.
   */
  readonly lookupUrl: string;
}

/**
 * Applies the contract's "which URLs are ours" rules: `https`, a host from `allowedHosts`
 * (already lower-cased), no user info, no port or port 443, and a path of exactly one slug.
 */
export function parseStrybokLink(
  input: unknown,
  allowedHosts: ReadonlySet<string>,
): StrybokLinkParts | null {
  const url = parseUrl(input);
  if (url === null) return null;
  if (url.scheme !== 'https') return null;
  if (url.userInfo !== null) return null;
  if (url.port !== null && url.port !== 443) return null;
  if (!allowedHosts.has(url.host)) return null;
  if (!SLUG_PATH.test(url.path)) return null;
  const campaign = campaignQuery(url.query);
  return {
    host: url.host,
    path: url.path,
    lookupUrl: `https://${url.host}${url.path}${campaign === '' ? '' : `?${campaign}`}`,
  };
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
  if (query === null || query === '') return '';
  const first = new Map<string, string | null>();
  for (const part of query.split('&')) {
    const equals = part.indexOf('=');
    const key = decodeQueryComponent(equals >= 0 ? part.slice(0, equals) : part);
    if (key === null || first.has(key)) continue;
    if (!(CAMPAIGN_QUERY_KEYS as readonly string[]).includes(key)) continue;
    // A value that cannot be decoded still is the first occurrence of its key.
    first.set(key, equals >= 0 ? decodeQueryComponent(part.slice(equals + 1)) : '');
  }
  const kept: string[] = [];
  for (const key of CAMPAIGN_QUERY_KEYS) {
    const value = first.get(key);
    if (typeof value === 'string' && CAMPAIGN_VALUE.test(value)) kept.push(`${key}=${value}`);
  }
  return kept.join('&');
}

/**
 * The decoded value of the first parameter named `name` in a raw query string, parsed like the
 * campaign query. `null` when there is none, or when it cannot be decoded.
 */
export function firstQueryValue(query: string | null, name: string): string | null {
  if (query === null || query === '') return null;
  for (const part of query.split('&')) {
    const equals = part.indexOf('=');
    const key = decodeQueryComponent(equals >= 0 ? part.slice(0, equals) : part);
    if (key !== name) continue;
    return equals >= 0 ? decodeQueryComponent(part.slice(equals + 1)) : '';
  }
  return null;
}

/**
 * Percent-decodes as UTF-8 with `+` as a space, like `URLSearchParams`. `null` for a malformed
 * escape or invalid UTF-8, which that class would turn into text no key or value of ours can be.
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
