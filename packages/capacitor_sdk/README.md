# @strybok/capacitor

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

Full guide, native setup and troubleshooting:
[`docs/capacitor.md`](../../docs/capacitor.md).

- **Not published to npm yet**: covered by unit tests with fake plugins only. It has not been run
  inside a real Capacitor app, nor on a physical device.
- Deferred deep linking is not supported.

## Install

`npm install @strybok/capacitor` will work only after publication. Until then, build tarballs from
`https://github.com/strybok/strybok-js`. The package depends on `@strybok/js`, which is not on
npm either, so both tarballs are needed:

```sh
git clone https://github.com/strybok/strybok-js
cd strybok-js
pnpm install && pnpm build
(cd packages/js_sdk && pnpm pack)
(cd packages/capacitor_sdk && pnpm pack)

# in your app, both in one command
npm install /path/to/strybok-js/packages/js_sdk/strybok-js-0.1.0.tgz \
  /path/to/strybok-js/packages/capacitor_sdk/strybok-capacitor-0.1.0.tgz
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
