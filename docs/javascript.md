# JavaScript core (`@strybok/js`)

`@strybok/js` is the platform-neutral core of the JavaScript SDKs. It contains everything the
[SDK contract](./sdk-contract.md) describes (the allowlist, resolving, retries, exactly-once
delivery, `app_open` events) and nothing platform-specific. Two things are plugged in from the
outside:

- a **`LinkSource`**: where incoming URLs come from;
- a **`fetch`** function: how HTTP requests are sent (the global `fetch` by default).

Use it directly when there is no ready-made adapter for your runtime (Cordova, NativeScript, a
custom WebView shell, ...). For React Native and Expo use
[`@strybok/react-native`](./react-native.md); for Capacitor and Ionic use
[`@strybok/capacitor`](./capacitor.md). Both are thin wrappers around this package and re-export
its whole API.

> **Status:** covered by unit tests (a port of the Flutter SDK's test suite, the reference test
> list, plus tests of the URL parser, timing and delivery). Not verified on physical devices yet;
> treat 0.x as an early release.
>
> Deferred links (a link tapped before the app is installed, restored after installation) are
> **optional, off by default and not verified on a device**. This package has no native code, so
> your app supplies the store's install referrer (Android) or the text the person pasted (iOS):
> see [Deferred links](#deferred-links-optional).
>
> Links without an API call (path links and Firebase long links, new in 0.4.0) are **optional,
> off by default and not verified on a device**: see
> [Links without an API call](#links-without-an-api-call-optional).

## 1. Prerequisites

1. Create an application in Strybok with your iOS and Android identifiers.
2. Complete the native setup: [Android](./android.md) and [iOS](./ios.md). Without it the OS
   never hands links to the app, and the SDK has nothing to receive.
3. Make sure your runtime gives JavaScript the URL that opened the app. That is what a
   `LinkSource` wraps (section 4).

## 2. Add the package

```sh
npm install @strybok/js@^0.4.0
```

This guide describes 0.4.0. The package is ESM only, has no dependencies and needs these from
the runtime: `Promise`, `setTimeout`, `JSON`, `encodeURIComponent`, and either a global `fetch`
or the `fetch` option. `AbortController` and `crypto.getRandomValues` are used when they exist.
It does not use the `URL` class.

## 3. Use it

```ts
import { Strybok } from '@strybok/js';

const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource: myLinkSource, // see section 4
  platform: 'android', // 'ios' | 'android' | 'unknown'
  onError: (error) => console.warn('Link failed', error),
});

const unsubscribe = strybok.onLink((link) => {
  // link.routePath === '/invite/abc123'
  // link.payload.invitationId === 'abc123'
  openRoute(link.routePath, link.payload);
});
await strybok.initialize();
```

Create **one** instance for the lifetime of the app. One listener covers every case:

| Situation                                 | What happens                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Cold start** (app launched by the link) | `initialize()` resolves the launch link. It is kept until a listener is attached, then delivered once. |
| **Background** (app resumed by the link)  | Delivered to the listeners.                                                                            |
| **Foreground**                            | Delivered to the listeners.                                                                            |

If the platform reports the same tap twice (for example as launch URL _and_ through the
subscription), the duplicate is dropped (`dedupeWindowMs`, 2 s by default). The same link tapped
again later is a new delivery.

Prefer to read the launch link yourself? `await strybok.getInitialLink()` returns it at most once
and removes it from the queue, so combining both never navigates twice.

### Campaign values

Every `ResolvedLink` has `campaign`: an object with the optional strings `source`, `medium`,
`campaign`, `term` and `content` (type `LinkCampaign`). It is never `null`; a value that is not
set is absent, and the object is empty when there are none.

```ts
strybok.onLink((link) => {
  analytics.track('link_opened', {
    source: link.campaign.source, // 'instagram', or undefined
    campaign: link.campaign.campaign,
  });
  router.push(link.routePath);
});
```

- **Where the values come from.** A link can have default values, set per link in the dashboard
  ("Campaign (optional)" in the link form). The `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term` and `utm_content` parameters of the URL that was tapped override them one by one:
  if the link's default source is `newsletter`,
  `https://my-app.strybok.link/invite777?utm_source=instagram` arrives with the source
  `instagram` and the link's other defaults. A parameter can replace a default but
  not clear it.
- **Which values are accepted.** 1–64 characters of letters, digits, `.`, `_`, `~` and `-`.
  Anything else (a space, `+`, letters outside ASCII) is dropped as if the parameter were absent,
  without an error: write `spring_sale`, not `spring sale`.
- **They are untrusted labels.** Whoever shares a link can put any `utm_*` values on it. Use them
  for attribution, never to grant anything or to decide what the user may see.
- **What is sent.** Of the tapped URL's query only these five parameters are sent when resolving,
  and the resolved values are reported with the `app_open` event (section "Analytics and
  privacy"); every other parameter and the fragment stay on the device. In the dashboard, a link's analytics has a "Campaigns" breakdown of opens
  by source, medium and campaign.

### API

| Member                            | Purpose                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize()`                    | Subscribe to the link source, then handle the launch URL. Resolves when the launch link was handled. Idempotent.                                               |
| `onLink(listener)`                | Receive `ResolvedLink`s (`url`, `linkId`, `appId`, `routePath`, `payload`, `campaign`, `isDeferred`, `isProbabilisticMatch`). Returns an unsubscribe function. |
| `getInitialLink()`                | The launch link, if no listener has received it yet; otherwise `null`.                                                                                         |
| `resolveUrl(url)`                 | Resolve a URL explicitly (QR scanner, tests). Does not call listeners and does not report an app open.                                                         |
| `isStrybokUrl(url)`               | Whether a URL is one of this app's links. No network call.                                                                                                     |
| `createLink(routePath, options?)` | Create a short link to share (section 6). Resolves with `{ url, slug, routePath, linkId }`.                                                                    |
| `dispose()`                       | Stop listening, cancel requests in flight, drop queued links. The instance cannot be reused.                                                                   |
| `enableDeferredLinks()`           | Switch [deferred links](#deferred-links-optional) on after start, e.g. after a consent screen.                                                                 |
| `redeemPastedLink(text)`          | iOS: exchange the link the person pasted. Resolves with a result string, never rejects.                                                                        |
| `skipPastedLink()`                | iOS matching only: the person moved on without pasting.                                                                                                        |
| `deferredLinkStatus`              | Where the deferred-link check stands; `'disabled'` by default.                                                                                                 |
| `onDeferredLinkStatus(listener)`  | Observe that status. Returns an unsubscribe function.                                                                                                          |

Details worth knowing:

- Links resolved while no listener is attached are queued and handed to the first listener that
  attaches, in order, on the next microtask (not inside the `onLink` call itself).
- With several listeners, each one receives every link once.
- An exception thrown by a listener or by `onError` does not stop delivery; it is rethrown from a
  timer so that it reaches your global error handler.
- After `dispose()`, `initialize()`, `getInitialLink()`, `resolveUrl()` and `createLink()` reject with a plain
  `Error`; `onLink()` does nothing.

### Options

| Option           | Default     | Meaning                                                                                                                                                            |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiBaseUrl`     | required    | Base URL of the API, e.g. `https://api.strybok.com`. A path prefix is preserved.                                                                                   |
| `allowedHosts`   | required    | Bare hostnames of this app's links (no scheme, no path): the managed hostname and an active [custom domain](./ios.md#custom-domain-optional). Compared lower-case. |
| `linkSource`     | required    | Where URLs come from (section 4).                                                                                                                                  |
| `platform`       | `'unknown'` | Reported with `app_open` events: `'ios'`, `'android'` or `'unknown'`.                                                                                              |
| `fetch`          | global      | HTTP transport (section 5).                                                                                                                                        |
| `timeoutMs`      | `5000`      | Time allowed for one resolve attempt, including reading the body.                                                                                                  |
| `maxRetries`     | `2`         | Extra attempts after a timeout, network error or 5xx. 4xx is never retried.                                                                                        |
| `retryDelayMs`   | `400`       | Pause before the first retry; doubles for each further retry.                                                                                                      |
| `dedupeWindowMs` | `2000`      | The identical URL received again within this window is dropped.                                                                                                    |
| `reportAppOpens` | `true`      | Send a best-effort `app_open` event after a link was resolved.                                                                                                     |
| `onError`        | none        | Receives errors for our links that could not be resolved.                                                                                                          |
| `clientKey`      | none        | Publishable client key `pk_…` of the application. Only needed for `createLink`.                                                                                    |
| `parameterLinks` | none        | `{ payloadKeys: [...] }`: also accept path links and Firebase long links; see [Links without an API call](#links-without-an-api-call-optional).                    |
| `deferredLinks`  | `false`     | Restore a link tapped before installation; see [Deferred links](#deferred-links-optional) for the options that go with it.                                         |

These are the options of the [SDK contract](./sdk-contract.md); durations carry an `Ms` suffix
because they are plain numbers in JavaScript. Invalid options make the constructor throw
(`TypeError` / `RangeError`) instead of failing later on a device.

### Which URLs are accepted

Exactly the contract's rules: `https`, host in `allowedHosts`, no `user:pass@`, no port or port
443, and a path of one slug (`^/[A-Za-z0-9_-]{1,64}$`, no trailing slash). Query and fragment are
allowed and do not decide whether a URL is accepted. Of the query only the five `utm_*` campaign
parameters are sent to the API ([Campaign values](#campaign-values)); the rest of it and the
fragment are **never sent**. With the `parameterLinks` option route paths and Firebase long links
are accepted too, and the configured payload keys are sent with them:
[Links without an API call](#links-without-an-api-call-optional).

The check uses a small strict parser of its own instead of the runtime's `URL` class, which is
incomplete in some runtimes. It does not normalise anything and rejects what a lenient parser
would repair: whitespace or control characters anywhere, backslashes, percent-encoded or
non-ASCII characters in the host, an empty port, an empty user info (`https://@host/...`).
Anything rejected is ignored silently by the automatic flow and rejected with
`UnsupportedLinkError` by `resolveUrl`.

### Errors

`resolveUrl` rejects with, and `onError` receives, a `StrybokError`. Every error has `name`,
`kind` and, when known, `url`. The errors of `createLink` are listed in section 6.

| Class                  | `kind`             | Meaning                                                                                     |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `UnsupportedLinkError` | `unsupported_link` | Not one of this app's links. Thrown before any network call; never passed to `onError`.     |
| `LinkNotFoundError`    | `link_not_found`   | 404: unknown, disabled or expired link.                                                     |
| `StrybokNetworkError`  | `network`          | The request could not be completed, after all retries. `cause` holds the transport's error. |
| `StrybokTimeoutError`  | `timeout`          | No answer in time, after all retries.                                                       |
| `StrybokServerError`   | `server`           | Unexpected status or malformed body. `statusCode` holds the status.                         |

`kind` is there for code that cannot rely on `instanceof` (two copies of the package in one
bundle).

## 4. Writing a `LinkSource`

```ts
interface LinkSource {
  /** The URL that launched the app (cold start), or null. */
  getInitialUrl(): Promise<string | null | undefined>;
  /** Report URLs received while the app runs; return a function that stops it. */
  subscribe(listener: (url: string) => void): () => void;
}
```

Rules of thumb:

- Pass URLs through **unchanged**, as strings. Do not filter them: the SDK ignores everything that
  is not one of your links (custom schemes, other hosts, OAuth redirects).
- `subscribe` is called first, then `getInitialUrl`. If your platform reports the launch URL in
  both places, report it in both; the SDK de-duplicates it.
- If the platform has no "launch URL" call, return `null` from `getInitialUrl` and make sure the
  launch URL reaches `subscribe` listeners instead (most plugins hold it back until the first
  subscriber).
- A rejected `getInitialUrl` is treated as "no launch link".

The examples below show the shape only. Plugin APIs differ between versions, and none of these
snippets has been run on a device: check them against the documentation of the plugin you use.

### Cordova

With a universal-links plugin that exposes `universalLinks.subscribe` (for example
`cordova-universal-links-plugin` and its forks), which keeps the launch event until somebody
subscribes:

```ts
import { Strybok, type LinkSource } from '@strybok/js';

declare const universalLinks: {
  subscribe(eventName: string | null, callback: (event: { url: string }) => void): void;
  unsubscribe(eventName: string | null): void;
};
declare const device: { platform: string }; // cordova-plugin-device

const cordovaLinks: LinkSource = {
  getInitialUrl: async () => null, // delivered through subscribe()
  subscribe(listener) {
    universalLinks.subscribe(null, (event) => listener(event.url));
    return () => universalLinks.unsubscribe(null);
  },
};

document.addEventListener('deviceready', () => {
  const os = device.platform.toLowerCase();
  const strybok = new Strybok({
    apiBaseUrl: 'https://api.strybok.com',
    allowedHosts: ['my-app.strybok.link'],
    linkSource: cordovaLinks,
    platform: os === 'ios' || os === 'android' ? os : 'unknown',
  });
  strybok.onLink((link) => openRoute(link.routePath, link.payload));
  void strybok.initialize();
});
```

Requests from a Cordova WebView are cross-origin browser requests; see section 5.

### NativeScript

With a plugin that offers a callback and a "current link" getter (for example
`@nativescript-community/universal-links`):

```ts
import { isAndroid, isIOS } from '@nativescript/core';
import {
  getUniversalLink,
  registerUniversalLinkCallback,
} from '@nativescript-community/universal-links';
import { Strybok, type LinkSource } from '@strybok/js';

let current: ((url: string) => void) | null = null;
registerUniversalLinkCallback((url: string) => current?.(url));

const nativeScriptLinks: LinkSource = {
  getInitialUrl: async () => getUniversalLink() ?? null,
  subscribe(listener) {
    current = listener;
    return () => {
      if (current === listener) current = null;
    };
  },
};

export const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource: nativeScriptLinks,
  platform: isIOS ? 'ios' : isAndroid ? 'android' : 'unknown',
});
```

### Your own native shell

If your own native code receives the link (`application(_:continue:restorationHandler:)` on iOS,
`onCreate` / `onNewIntent` on Android) and forwards it into a WebView or JS engine, expose two
things to JavaScript and wrap them:

```ts
declare const nativeBridge: {
  getLaunchUrl(): Promise<string | null>;
  onUrl(callback: (url: string) => void): () => void;
};

const bridgeLinks: LinkSource = {
  getInitialUrl: () => nativeBridge.getLaunchUrl(),
  subscribe: (listener) => nativeBridge.onUrl(listener),
};
```

## 5. HTTP transport

By default the SDK calls the global `fetch`. Replace it with the `fetch` option when the runtime
has none, or when the default one is unsuitable:

```ts
import type { FetchLike } from '@strybok/js';

const transport: FetchLike = async (url, { method, headers, body, signal }) => {
  const response = await myHttpClient.request({ url, method, headers, body, signal });
  return { status: response.status, text: async () => response.bodyText };
};
```

Only `status` and `text()` of the response are used, plus `headers.get('Retry-After')` when the
response has `headers` (optional; it fills `retryAfterSeconds` of a rate-limited `createLink`).
The SDK sends three kinds of request: `GET .../v1/public/resolve?url=...` with
`Accept: application/json`, `POST .../v1/public/events` with a JSON string body, and, only when
you call `createLink`, `POST .../v1/public/links` with a JSON string body and the `X-Strybok-Key`
header. `signal` is an `AbortSignal` (when the
runtime has `AbortController`) that is aborted on timeout and on `dispose()`; a transport that
ignores it still times out correctly, the request is just not cancelled.

**WebViews and CORS.** A `fetch` made by a page inside a WebView (Cordova, Capacitor, a custom
shell) is a cross-origin browser request. The API's public SDK endpoints (`/v1/public/*`) allow
any origin, so it works; an API deployment older than 2026-11-24 does not, and requests then
surface as `StrybokNetworkError`. Sending requests natively avoids the preflight altogether:
`@strybok/capacitor` does this for you; on Cordova you can wrap a native HTTP plugin as shown
above. React Native and NativeScript are not affected (their `fetch` is not a browser).

## 6. Create a link to share

`createLink` asks the service for a short link to a screen of your app, for a "Share" button:

```ts
const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource,
  clientKey: 'pk_...', // the application's publishable client key
});

const link = await strybok.createLink('/product/42', {
  payload: { productId: 42 },
  title: 'Red shoes',
  description: 'Look at these',
  imageUrl: 'https://cdn.example.com/shoes.png',
});
await share(link.url); // also: link.slug, link.routePath, link.linkId
```

**Enable it first.** In the dashboard, open the application, switch on "Links from the app" and
list the route patterns the app may create links for. The page shows the publishable client key
(`pk_…`) to pass as `clientKey`. The key is safe to ship inside the app: it can only create links
for those route patterns. Never put a secret API key (`lb_…`) into an app.

- Only `routePath` is required; `payload` (a JSON object), `title`, `description` and `imageUrl`
  are optional, and what you leave out is not sent.
- Creating the same link again (same route, payload, title, description and image) returns the
  existing link instead of making a second one.
- It runs only when you call it. It does not need `initialize()` and is never part of the app's
  start.
- It uses the same `timeoutMs`, `maxRetries` and `retryDelayMs` as resolving: timeouts, network
  errors and 5xx are retried with an identical request, 4xx (including 429) never.
- After `dispose()` it rejects with a plain `Error`.

It rejects with a `StrybokError`; these errors are never passed to `onError`, which is for
incoming links, and never contain the client key or the payload.

| Class                      | `kind`              | Meaning                                                                                                                                                               |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StrybokUnauthorizedError` | `unauthorized`      | No `clientKey` configured (no request is made), or 401: the key is wrong or was replaced, or the feature is switched off.                                             |
| `RouteNotAllowedError`     | `route_not_allowed` | 403: the route is not covered by the application's route patterns. `routePath` holds the route.                                                                       |
| `StrybokRateLimitedError`  | `rate_limited`      | 429: too many requests, or the app's daily limit of new links is reached. `retryAfterSeconds` holds the `Retry-After` header, if any.                                 |
| `StrybokValidationError`   | `validation`        | Rejected before sending (`routePath` must start with one `/` and be at most 512 characters; `payload` must be a JSON object), or 400/413/422. `statusCode`, `issues`. |
| `StrybokNetworkError`      | `network`           | The request could not be completed, after all retries. `cause` is not set here.                                                                                       |
| `StrybokTimeoutError`      | `timeout`           | No answer in time, after all retries.                                                                                                                                 |
| `StrybokServerError`       | `server`            | 5xx after all retries, any other status, or a success answer that cannot be read. `statusCode` holds the status.                                                      |

`StrybokRateLimitedError`, `StrybokNetworkError`, `StrybokTimeoutError` and `StrybokServerError`
are temporary: let the user try again later (after `retryAfterSeconds` when present).
`StrybokUnauthorizedError`, `RouteNotAllowedError` and `StrybokValidationError` do not go away by
retrying; the app or the dashboard settings need a change.

## 7. Treat routes as untrusted input

`routePath`, `payload` and `campaign` are data from the network, chosen by whoever created or
shared the link. Match the route against routes your app knows before navigating, never execute
payload contents, and treat campaign values as labels only. The SDK only guarantees that
`routePath` starts with a single `/`.

## 8. Links that arrive before sign-in

If a link needs an authenticated user, remember the route and open it after login instead of
dropping it. Because links are queued until the first listener attaches, another option is to
attach the listener only once the user is signed in.

## 9. Analytics and privacy

After a link is delivered (or queued) the SDK sends one best-effort `app_open` event
(`POST /v1/public/events`) containing a random event id, the link id, the platform, the SDK
version and the link's campaign values when it has any, and nothing else: no device identifiers. It never delays navigation and all failures are
ignored. Disable it with `reportAppOpens: false`.

Only the link's host and slug are sent to `resolve`, plus the five `utm_*` campaign parameters of
the tapped URL when their value passes the character rule
([Campaign values](#campaign-values)). Every other query parameter and the fragment stay on the
device.

With `parameterLinks` set, the SDK also sends the path of a path link and the values of the
payload keys you configured, or for a Firebase long link the deep link's scheme, host and path,
its values of those keys and the `apn` and `ibi` parameters
([Links without an API call](#links-without-an-api-call-optional)). Do not configure keys that
carry personal data.

With `deferredLinks` switched on, the SDK additionally sends what
[Deferred links](#deferred-links-optional) describes: the click id from the install referrer or
from the pasted link with your app identifier, or — only with `allowProbabilisticMatching` — the
bundle id, device family and language, which the server combines with the connection's IP
address.

The event id is a random UUID v4, generated with `crypto.getRandomValues` where available and
with `Math.random` otherwise. It only de-duplicates events and is not a security token.

## 10. Testing your integration

`@strybok/js/testing` provides `FakeLinkSource`:

```ts
import { Strybok } from '@strybok/js';
import { FakeLinkSource } from '@strybok/js/testing';

const source = new FakeLinkSource({ initialUrl: 'https://my-app.strybok.link/abc' });
const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource: source,
  fetch: async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({ linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' }),
  }),
});

const routes: string[] = [];
strybok.onLink((link) => routes.push(link.routePath));
await strybok.initialize(); // cold start
source.emit('https://my-app.strybok.link/other'); // link while running
```

`new FakeLinkSource({ initialUrl, replayInitialUrlOnSubscribe: true })` mimics platforms that
report the launch URL twice. The `now` option of `Strybok` replaces the clock used for
de-duplication.

## Links without an API call (optional)

The owner can let any address of the app's link hosts open a route without creating a link
first (dashboard: Setup → Links without an API call): **path links** such as
`https://my-app.strybok.link/product/42?id=7`, and **Firebase long links**
`https://my-app.strybok.link/?link=https://example.com/product/42&apn=…`. Without the SDK option
the SDK ignores a path of several segments and a long link (nothing is delivered, no request is
made) and resolves a one-segment path without its payload, as 0.3.0 did.

To receive them, pass `parameterLinks` (new in 0.4.0). Copy its value from `parameterLinks` of
the application's integration guide (`GET /v1/apps/:appId/integration`, also shown on the
dashboard's setup screen); it is `null` while both kinds are off, and then you leave the option
out:

```ts
const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource,
  parameterLinks: { payloadKeys: ['id', 'lang'] }, // parameterLinks of the integration guide
});

strybok.onLink((link) => {
  // https://my-app.strybok.link/product/42?id=7&lang=uk → '/product/42', { id: '7', lang: 'uk' }
  openRoute(link.routePath, link.payload);
});
```

- **The server decides.** Whether a kind is on, which routes are allowed and what the payload is
  (strings only). The delivered link has the `routePath` and `payload` of the answer, never the
  tapped path, and is as untrusted as any link. `app_open` carries the answer's `linkId`.
- **What is sent.** The path as received and, of the query, only the configured keys (first
  occurrence, 1–256 characters, no control characters) and the `utm_*` values; for a long link
  the deep link rebuilt from its scheme, host, path and payload keys, plus `apn` and `ibi`. Never
  the fragment or any other parameter (`afl`, `ifl`, `ofl`, `st`, `sd`, `si`, `isi`, ...).
- **What is accepted** besides one slug: a route path (at most 512 characters, no `//`, no `.` or
  `..` segment, not `/.well-known/…`, `/favicon.ico` and the like) and a long link at `/` whose
  `link` is an `http(s)` URL without user info or port. An address that passes but is no link
  answers 404: `onError` gets `LinkNotFoundError`, as for an unknown slug.
- **The keys are compiled into the app.** When the owner changes them, installed builds keep
  sending the keys they know until your next release. Invalid keys (more than 20, one twice, not
  1–40 characters of `A–Z a–z 0–9 _ . -`, `utm_…`, `st`, `sd`, `si`, `strybok_click`) make the
  constructor throw.
- **Deferred links** are unchanged: they restore only links you created, with one slug.

The exact rules, with the shared test vectors every SDK runs:
[SDK contract](./sdk-contract.md#links-without-an-api-call). Unit-tested only; not verified on a
device.

## Deferred links (optional)

A person taps a link, does not have the app, installs it and opens it: with deferred links the
app can still receive that link. It is **off by default**, it is very different on Android and
iOS, and **nothing of it has been verified on a device**. Read the platform side first — what
the owner switches on in the dashboard, what the visitor sees and what it costs:
[Android](./android.md#links-tapped-before-the-app-is-installed-deferred-links) and
[iOS](./ios.md#links-tapped-before-the-app-is-installed). The exact behaviour is the
[SDK contract](./sdk-contract.md#deferred-links-optional-android).

**This package ships no native code and no store integration.** It contains the logic (when to
ask, what to send, once only, a normal link wins) and its tests. Everything that touches the
device comes from your app:

| You pass                                                | Platform | What it is                                                                                                                                            |
| ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deferredLinks: true` (or call `enableDeferredLinks()`) | both     | The switch. Without it nothing below is read, stored or sent.                                                                                         |
| `deferredLinkStore`                                     | both     | Persistent storage with `getItem(key)` and `setItem(key, value)` (sync or promise). **Required**: without it the status stays `disabled`.             |
| `androidPackageName`                                    | Android  | Your application ID. Required on Android.                                                                                                             |
| `installReferrerSources`                                | Android  | Functions that ask a store for its install referrer (below). Without any the check ends with `unavailable`.                                           |
| `iosBundleId`                                           | iOS      | Your bundle identifier. Required on iOS.                                                                                                              |
| the pasted text, to `redeemPastedLink(text)`            | iOS      | What the person pasted with your paste button. The SDK never reads the clipboard.                                                                     |
| `allowProbabilisticMatching`, `deviceFamily`, `locale`  | iOS      | Only for probabilistic matching, which is **forbidden by Apple's rules** and not recommended (below).                                                 |
| `pasteboardMayContainLink`                              | iOS      | Optional, matching only: answers whether the clipboard probably holds a URL **without reading it**; the SDK then waits for the paste before matching. |

The store keeps two values, `strybok.deferred.attempts` and `strybok.deferred.done`, and nothing
else — never the referrer, the pasted text or the click id. It must survive restarts and
disappear with the app's data. The SDK deliberately has no in-memory fallback: state that is
forgotten on restart would run the check again on every launch.

A restored link arrives through `onLink` like any other, with `isDeferred: true`. Every
`ResolvedLink` has `isDeferred` and `isProbabilisticMatch` (both `false` for ordinary links).
`getInitialLink()` never returns a deferred link, no `app_open` event is sent for it, and
nothing about the check is ever reported to `onError`.

### Android: install referrer

On the first launch after `initialize()` has finished (never before, and `initialize()` does not
wait for it) the SDK asks your sources in order, looks for `strybok_click=dc_…` in the referrer
string and exchanges that id once for the link (`POST /v1/public/deferred-links/redeem` with the
id, `androidPackageName` and the SDK version — nothing else of the referrer is sent, stored or
logged).

```ts
import { Strybok, type InstallReferrerSource } from '@strybok/js';

// Yours to write: call the Play Install Referrer library from native code (see below).
const playInstallReferrer: InstallReferrerSource = async () => {
  const result = await myNativeBridge.getPlayInstallReferrer();
  // Exactly one of these three answers:
  if (result.ok) return { status: 'referrer', referrer: result.referrer }; // may be ''
  if (result.retryLater) return { status: 'unavailableForNow' };
  return { status: 'unavailable' };
};

const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource,
  platform: 'android',
  deferredLinks: true,
  deferredLinkStore: myPersistentStore, // getItem / setItem
  androidPackageName: 'com.example.app',
  installReferrerSources: [playInstallReferrer],
});
```

What the native side has to do for Google Play (library
`com.android.installreferrer:installreferrer:2.2`, class `InstallReferrerClient`): call
`startConnection`, and map the result of `onInstallReferrerSetupFinished` like this, always
followed by `endConnection()`:

| Result                                                                     | Answer                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `OK` (0)                                                                   | `{ status: 'referrer', referrer: client.installReferrer.installReferrer }` |
| `SERVICE_UNAVAILABLE` (1), `SERVICE_DISCONNECTED` (-1), a remote exception | `{ status: 'unavailableForNow' }`                                          |
| `FEATURE_NOT_SUPPORTED` (2), `DEVELOPER_ERROR` (3)                         | `{ status: 'unavailable' }`                                                |

A source that throws, rejects or takes longer than 10 seconds counts as "unavailable for now".
The check is repeated on a later launch after a transient failure, at most three times per
installation; then it is `failed` for good.

Huawei AppGallery and Samsung Galaxy Store have their own referrer mechanisms (described in the
contract). **They are unverified even in the native Strybok SDKs**; if you write sources for
them, add them after the Play source.

Reading the install referrer is access to information stored on the device. If your app needs
consent first, leave `deferredLinks` off and call `strybok.enableDeferredLinks()` after the
consent screen; that runs the check once.

### iOS: the pasted link

The App Store passes nothing to a newly installed app. With the owner's "copy and paste the
link" option the visitor copies the link on a page before the App Store; in your app, a paste
button of yours hands the text over:

```ts
const result = await strybok.redeemPastedLink(pastedText);
// 'delivered' | 'notOurs' | 'notFound' | 'alreadyHandled' | 'disabled' | 'failed'
```

- `delivered` — the link went to your `onLink` listeners (also when another link was delivered
  earlier in this launch).
- `notOurs` — the text is not a link of this app with a click id. Nothing was sent anywhere and
  the text was dropped.
- `notFound` — unknown, older than 24 hours, already used, or another app's.
- `alreadyHandled` — a deferred link was handled on this installation before.
- `failed` — no answer for now (the person can tap Paste again) or an unusable one.
- `disabled` — `deferredLinks` is off, the platform is not iOS, or the store or `iosBundleId`
  is missing.

It never rejects. **Use the system paste control (`UIPasteControl`, iOS 16 or later) or a paste
action the person starts themselves; never read the clipboard on launch.** Put the button on the
first screen or in onboarding with a sentence that says what it does, and describe it in your App
Review notes. What it costs: every iOS visitor without the app gets an extra page and an extra
tap before the App Store, and it only works for the people who then actually paste — expect a
minority.

### iOS: probabilistic matching (not recommended)

With `allowProbabilisticMatching: true` (in addition to `deferredLinks`, the owner's setting and
the per-link permission) the SDK asks the server on the first launch whether exactly one recent
tap came from the same network address, device family and language
(`POST /v1/public/deferred-links/match` with `iosBundleId`, `deviceFamily()`, `locale()` and the
SDK version — nothing else). Read [the costs](./ios.md#option-not-recommended-probabilistic-matching-iosdeferredmatching)
before you switch it on:

- **Apple forbids it** (fingerprinting, with or without consent). The App Review and legal risk
  is the app owner's.
- **A match is a guess.** On a shared network (Wi-Fi, office, carrier NAT) it can be another
  person's link. Such a link has `isProbabilisticMatch: true`: never sign anyone in, accept an
  invitation, apply a personal discount or show personal content on the strength of it alone.
- It does not work with iCloud Private Relay or a VPN, or after a change of network.
- It makes the service process IP addresses: your privacy policy and App Store privacy labels
  must cover it, and you may need consent.
- It must be allowed per link, and nobody knows how accurate it is.

`deviceFamily` must answer `'iphone'`, `'ipad'` or `'ipod'` and `locale` the first preferred
language (for example `'en-GB'`); anything else ends the check with `unavailable`.

### Status

`strybok.deferredLinkStatus` says where the check stands, and
`strybok.onDeferredLinkStatus(listener)` reports changes. It is for development and QA; most
installs never tapped a link, so "found nothing" is the normal result and not an error.

| Status           | Meaning                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `disabled`       | `deferredLinks` is off, the platform is neither Android nor iOS, or the store or the app identifier was not passed  |
| `pending`        | Not finished in this launch (not started yet, or the store or the network was not reachable); a later launch tries  |
| `checking`       | Running now                                                                                                         |
| `notFirstLaunch` | Finished in an earlier launch                                                                                       |
| `unavailable`    | No source can answer. On iOS: matching is off (only a pasted link can restore anything), or family/language unknown |
| `noReferrer`     | The store's referrer has no click id of ours — an ordinary install                                                  |
| `notFound`       | The server refused the id: unknown, older than 24 hours, already used, or not this application's                    |
| `superseded`     | A normal link of this app arrived first; the deferred one is dropped (one launch, one navigation)                   |
| `delivered`      | The link was handed to `onLink`                                                                                     |
| `failed`         | Three launches could not finish, or the server's answer was unusable                                                |
| `awaitingPaste`  | iOS matching waits for `redeemPastedLink` or `skipPastedLink()` because `pasteboardMayContainLink` answered `true`  |

In a browser (`platform: 'unknown'`) there is nothing to restore: the status is `disabled`
whatever the options say.

## Troubleshooting

| Symptom                                         | Check                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Link opens the browser/store instead of the app | Native association is not verified: see the [Android](./android.md) and [iOS](./ios.md) guides. The SDK is not involved at this point.       |
| App opens but nothing happens                   | Does your `LinkSource` receive the URL at all? Host missing from `allowedHosts`? What does `onError` report? Is the API reachable?           |
| A path link or long link is ignored             | `parameterLinks` is not set (or the SDK is older than 0.4.0): see [Links without an API call](#links-without-an-api-call-optional).          |
| `StrybokNetworkError` only inside a WebView     | CORS: see section 5.                                                                                                                         |
| The constructor throws about `fetch`            | The runtime has no global `fetch`; pass the `fetch` option.                                                                                  |
| Screen opens twice                              | Two `Strybok` instances, or your framework's own deep-link handling also reacts to the URL.                                                  |
| The launch link is handled again after a reload | Platforms keep reporting the same launch URL for the whole process. Create the instance once; do not re-create it on hot reload or re-login. |
