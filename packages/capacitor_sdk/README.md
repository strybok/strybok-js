# @strybok/capacitor

[![npm](https://img.shields.io/npm/v/@strybok/capacitor.svg)](https://www.npmjs.com/package/@strybok/capacitor) [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

Strybok SDK for Capacitor and Ionic apps. Receives iOS Universal Links / Android App Links through
the [`@capacitor/app`](https://capacitorjs.com/docs/apis/app) plugin, resolves them through the
Strybok API to an in-app route and payload, and delivers each link exactly once: on cold start,
from the background and in the foreground.

A thin adapter over [`@strybok/js`](../js_sdk); no native code of its own.

```ts
import { createStrybok } from '@strybok/capacitor';

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
});

strybok.onLink((link) => openRoute(link.routePath, link.payload));
await strybok.initialize();
```

On iOS and Android, requests are sent with Capacitor's native HTTP (`CapacitorHttp`) rather than
the WebView's `fetch`, because the Strybok API does not allow cross-origin calls from WebView
origins.

Every delivered link also has `campaign`: the link's campaign values with the `utm_*` parameters
of the tapped URL on top, as the optional strings `source`, `medium`, `campaign`, `term` and
`content` (an empty object when there are none). They are labels chosen by whoever shared the
link, so use them for attribution only, for example `link.campaign.source`.

It can also create links to share. Pass the application's publishable `clientKey` to
`createStrybok` (enable "Links from the app" in the dashboard and list the allowed route patterns
there):

```ts
const link = await strybok.createLink('/product/42', {
  payload: { productId: 42 },
  title: 'Red shoes',
});
await Share.share({ url: link.url }); // @capacitor/share
```

`createLink` is sent natively like every other request, rejects with a typed error
(`StrybokUnauthorizedError`, `RouteNotAllowedError`, `StrybokRateLimitedError`,
`StrybokValidationError`, `StrybokNetworkError`, `StrybokTimeoutError`, `StrybokServerError`),
never runs during start-up and works without `initialize()`.

Full guide, native setup and troubleshooting:
[`docs/capacitor.md`](../../docs/capacitor.md).

- **Early release (0.x)**: covered by unit tests with fake plugins only. It has not been run
  inside a real Capacitor app, nor on a physical device.
- Deferred links (restoring a link tapped before the app was installed) are optional, off by
  default and unverified on devices; see below.
- Links without an API call (path links and Firebase long links, new in 0.4.0) are optional, off
  by default and unverified on devices; see below.

## Links without an API call (optional)

Path links such as `https://my-app.strybok.link/product/42?id=7` and Firebase long links
(`https://my-app.strybok.link/?link=…`) open a route without a link being created first. The SDK
accepts them only with the `parameterLinks` option; copy its value from `parameterLinks` of the
application's integration guide (`GET /v1/apps/:appId/integration`, also shown on the dashboard's
setup screen):

```ts
export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  parameterLinks: { payloadKeys: ['id', 'lang'] },
});
```

The delivered link has the `routePath` and `payload` the server read, never the tapped path; of
the query only the configured keys and the `utm_*` values are sent. Without the option nothing
changes. Guide:
[`docs/capacitor.md`](../../docs/capacitor.md#links-without-an-api-call-optional).

## Deferred links (optional)

Off unless you pass `deferredLinks: true` (or call `enableDeferredLinks()` later, for example
after a consent screen). This package ships **no native code and no store integration of its
own**; the app supplies:

- `deferredLinkStore` — persistent storage with `getItem`/`setItem` (`@capacitor/app` and `@capacitor/core` have none, and this package does not add the Preferences plugin). Required: without it
  the status stays `disabled`.
- Android: `androidPackageName` and `installReferrerSources` — functions of yours that return the
  Play install referrer from a few lines of native code (example in the guide).
- iOS: `iosBundleId`, and the text the person pasted with your paste button, handed to
  `redeemPastedLink(text)`. The SDK never reads the clipboard.
- iOS probabilistic matching (`allowProbabilisticMatching`, with `deviceFamily` and `locale`
  callbacks) is forbidden by Apple's rules and can deliver another person's link; it is off by
  default and not recommended.

A restored link arrives through `onLink` with `isDeferred: true` (and `isProbabilisticMatch:
true` when it was guessed — never open anything personal on the strength of such a link).
Guide with the app-side code, costs and limits:
[`docs/capacitor.md`](../../docs/capacitor.md#deferred-links-optional).

## Install

```sh
npm install @strybok/capacitor@^0.4.0
```

## Development

From the repository root, after `pnpm install`:

```sh
pnpm --filter @strybok/capacitor lint
pnpm --filter @strybok/capacitor typecheck
pnpm --filter @strybok/capacitor test
pnpm --filter @strybok/js --filter @strybok/capacitor build   # ESM + .d.ts into dist/
```

`@capacitor/app` and `@capacitor/core` are peer dependencies and are not installed in this
repository; see [`peer-stubs/README.md`](./peer-stubs/README.md).

## Licence

Apache 2.0, see [LICENSE](./LICENSE).
