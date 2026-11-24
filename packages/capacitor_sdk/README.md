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
- Deferred deep linking is not supported.

## Install

```sh
npm install @strybok/capacitor
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
