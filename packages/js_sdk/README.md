# @strybok/js

[![npm](https://img.shields.io/npm/v/@strybok/js.svg)](https://www.npmjs.com/package/@strybok/js) [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

The platform-neutral core of the Strybok SDKs for JavaScript runtimes. It takes the URLs your app
receives as iOS Universal Links / Android App Links, asks the Strybok API which in-app route and
payload a link stands for, and delivers each link exactly once: on cold start, from the
background and in the foreground.

Zero runtime dependencies. Where the URLs come from is a small interface (`LinkSource`), so the
same core runs under React Native ([`@strybok/react-native`](../react_native_sdk)), Capacitor
([`@strybok/capacitor`](../capacitor_sdk)) and any other runtime you write a `LinkSource` for.

```ts
import { Strybok } from '@strybok/js';

const strybok = new Strybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource, // { getInitialUrl(): Promise<string | null>; subscribe(listener): unsubscribe }
  platform: 'ios',
});

strybok.onLink((link) => router.push(link.routePath));
await strybok.initialize();
```

Every delivered link also has `campaign`: the link's campaign values with the `utm_*` parameters
of the tapped URL on top, as the optional strings `source`, `medium`, `campaign`, `term` and
`content` (an empty object when there are none). They are labels chosen by whoever shared the
link, so use them for attribution only:

```ts
strybok.onLink((link) => {
  analytics.track('link_opened', { source: link.campaign.source });
  router.push(link.routePath);
});
```

It can also create links to share (needs the publishable `clientKey` option; enable "Links from
the app" for the application in the dashboard and list the allowed route patterns there):

```ts
const link = await strybok.createLink('/product/42', {
  payload: { productId: 42 },
  title: 'Red shoes',
});
await share(link.url);
```

`createLink(routePath, { payload?, title?, description?, imageUrl? })` resolves with
`{ url, slug, routePath, linkId }` and rejects with a typed error: `StrybokUnauthorizedError`,
`RouteNotAllowedError`, `StrybokRateLimitedError` (`retryAfterSeconds`), `StrybokValidationError`
(`issues`), `StrybokNetworkError`, `StrybokTimeoutError` or `StrybokServerError`. It never runs
during start-up and works without `initialize()`.

Full guide, including how to write a `LinkSource`:
[`docs/javascript.md`](../../docs/javascript.md). Behaviour is defined by
the [SDK contract](../../docs/sdk-contract.md).

- **Early release (0.x)**: covered by unit tests only; verification on physical devices is
  still pending.
- Deferred links (restoring a link tapped before the app was installed) are optional, off by
  default and unverified on devices; see below.

## Deferred links (optional)

Off unless you pass `deferredLinks: true` (or call `enableDeferredLinks()` later, for example
after a consent screen). This package has **no native code and no store integration**, so the
app supplies everything that touches the device:

- `deferredLinkStore` — persistent storage with `getItem`/`setItem`. Required: without it the
  status stays `disabled` (the state is never kept only in memory).
- Android: `androidPackageName` and `installReferrerSources`, functions that return the store's
  raw install referrer (`{ status: 'referrer', referrer }`), `{ status: 'unavailableForNow' }` or
  `{ status: 'unavailable' }`.
- iOS: `iosBundleId`, and the text the person pasted, handed to `redeemPastedLink(text)`. The SDK
  never reads the clipboard.
- iOS probabilistic matching (`allowProbabilisticMatching`, with `deviceFamily` and `locale`
  callbacks) is forbidden by Apple's rules and can deliver another person's link; it is off by
  default and not recommended.

A restored link arrives through `onLink` with `isDeferred: true` (and `isProbabilisticMatch:
true` when it was guessed — never open anything personal on the strength of such a link). It is
never returned by `getInitialLink()`, a normal link always wins over it, and it is delivered at
most once per installation. `deferredLinkStatus` / `onDeferredLinkStatus` show what the check
did. Guide, costs and limits:
[`docs/javascript.md`](../../docs/javascript.md#deferred-links-optional).

## Install

```sh
npm install @strybok/js
```

## Development

From the repository root, after `pnpm install`:

```sh
pnpm --filter @strybok/js lint
pnpm --filter @strybok/js typecheck
pnpm --filter @strybok/js test
pnpm --filter @strybok/js build   # ESM + .d.ts into dist/
```

Tests run from `src`; `exports` point to `dist`, which only `build` creates.

## Licence

Apache 2.0, see [LICENSE](./LICENSE).
