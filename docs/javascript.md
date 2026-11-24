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
> Deferred deep linking is **not supported**: a link tapped before the app is installed is not
> restored after installation.

## 1. Prerequisites

1. Create an application in Strybok with your iOS and Android identifiers.
2. Complete the native setup: [Android](./android.md) and [iOS](./ios.md). Without it the OS
   never hands links to the app, and the SDK has nothing to receive.
3. Make sure your runtime gives JavaScript the URL that opened the app. That is what a
   `LinkSource` wraps (section 4).

## 2. Add the package

```sh
npm install @strybok/js
```

The package is ESM only, has no dependencies and needs these from the runtime: `Promise`,
`setTimeout`, `JSON`, `encodeURIComponent`, and either a global `fetch` or the `fetch` option.
`AbortController` and `crypto.getRandomValues` are used when they exist. It does not use the
`URL` class.

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

### API

| Member                            | Purpose                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `initialize()`                    | Subscribe to the link source, then handle the launch URL. Resolves when the launch link was handled. Idempotent. |
| `onLink(listener)`                | Receive `ResolvedLink`s (`url`, `linkId`, `appId`, `routePath`, `payload`). Returns an unsubscribe function.     |
| `getInitialLink()`                | The launch link, if no listener has received it yet; otherwise `null`.                                           |
| `resolveUrl(url)`                 | Resolve a URL explicitly (QR scanner, tests). Does not call listeners and does not report an app open.           |
| `isStrybokUrl(url)`               | Whether a URL is one of this app's links. No network call.                                                       |
| `createLink(routePath, options?)` | Create a short link to share (section 6). Resolves with `{ url, slug, routePath, linkId }`.                      |
| `dispose()`                       | Stop listening, cancel requests in flight, drop queued links. The instance cannot be reused.                     |

Details worth knowing:

- Links resolved while no listener is attached are queued and handed to the first listener that
  attaches, in order, on the next microtask (not inside the `onLink` call itself).
- With several listeners, each one receives every link once.
- An exception thrown by a listener or by `onError` does not stop delivery; it is rethrown from a
  timer so that it reaches your global error handler.
- After `dispose()`, `initialize()`, `getInitialLink()`, `resolveUrl()` and `createLink()` reject with a plain
  `Error`; `onLink()` does nothing.

### Options

| Option           | Default     | Meaning                                                                          |
| ---------------- | ----------- | -------------------------------------------------------------------------------- |
| `apiBaseUrl`     | required    | Base URL of the API, e.g. `https://api.strybok.com`. A path prefix is preserved. |
| `allowedHosts`   | required    | Bare hostnames of this app's links (no scheme, no path). Compared lower-case.    |
| `linkSource`     | required    | Where URLs come from (section 4).                                                |
| `platform`       | `'unknown'` | Reported with `app_open` events: `'ios'`, `'android'` or `'unknown'`.            |
| `fetch`          | global      | HTTP transport (section 5).                                                      |
| `timeoutMs`      | `5000`      | Time allowed for one resolve attempt, including reading the body.                |
| `maxRetries`     | `2`         | Extra attempts after a timeout, network error or 5xx. 4xx is never retried.      |
| `retryDelayMs`   | `400`       | Pause before the first retry; doubles for each further retry.                    |
| `dedupeWindowMs` | `2000`      | The identical URL received again within this window is dropped.                  |
| `reportAppOpens` | `true`      | Send a best-effort `app_open` event after a link was resolved.                   |
| `onError`        | none        | Receives errors for our links that could not be resolved.                        |
| `clientKey`      | none        | Publishable client key `pk_…` of the application. Only needed for `createLink`.  |

These are the options of the [SDK contract](./sdk-contract.md); durations carry an `Ms` suffix
because they are plain numbers in JavaScript. Invalid options make the constructor throw
(`TypeError` / `RangeError`) instead of failing later on a device.

### Which URLs are accepted

Exactly the contract's rules: `https`, host in `allowedHosts`, no `user:pass@`, no port or port
443, and a path of one slug (`^/[A-Za-z0-9_-]{1,64}$`, no trailing slash). Query and fragment are
allowed, ignored, and **never sent** to the API.

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

`routePath` and `payload` are data from the network, chosen by whoever created the link. Match the
route against routes your app knows before navigating, and never execute payload contents. The SDK
only guarantees that `routePath` starts with a single `/`.

## 8. Links that arrive before sign-in

If a link needs an authenticated user, remember the route and open it after login instead of
dropping it. Because links are queued until the first listener attaches, another option is to
attach the listener only once the user is signed in.

## 9. Analytics and privacy

After a link is delivered (or queued) the SDK sends one best-effort `app_open` event
(`POST /v1/public/events`) containing a random event id, the link id, the platform and the SDK
version, and nothing else: no device identifiers. It never delays navigation and all failures are
ignored. Disable it with `reportAppOpens: false`.

Only the link's host and slug are sent to `resolve`; query parameters and fragments stay on the
device.

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

## Troubleshooting

| Symptom                                         | Check                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Link opens the browser/store instead of the app | Native association is not verified: see the [Android](./android.md) and [iOS](./ios.md) guides. The SDK is not involved at this point.       |
| App opens but nothing happens                   | Does your `LinkSource` receive the URL at all? Host missing from `allowedHosts`? What does `onError` report? Is the API reachable?           |
| `StrybokNetworkError` only inside a WebView     | CORS: see section 5.                                                                                                                         |
| The constructor throws about `fetch`            | The runtime has no global `fetch`; pass the `fetch` option.                                                                                  |
| Screen opens twice                              | Two `Strybok` instances, or your framework's own deep-link handling also reacts to the URL.                                                  |
| The launch link is handled again after a reload | Platforms keep reporting the same launch URL for the whole process. Create the instance once; do not re-create it on hot reload or re-login. |
