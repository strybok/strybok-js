# @strybok/react-native

[![npm](https://img.shields.io/npm/v/@strybok/react-native.svg)](https://www.npmjs.com/package/@strybok/react-native) [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

Strybok SDK for React Native and Expo. Receives iOS Universal Links / Android App Links through
React Native's `Linking` module, resolves them through the Strybok API to an in-app route and
payload, and delivers each link exactly once: on cold start, from the background and in the
foreground.

A thin adapter over [`@strybok/js`](../js_sdk). Pure JavaScript, no native module, so it also
works in Expo development builds without a config plugin.

```tsx
import { createStrybok, useStrybokLink } from '@strybok/react-native';

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
});

function App() {
  useStrybokLink(strybok, (link) => openRoute(link.routePath, link.payload));
  // ...
}
```

It can also create links to share. Pass the application's publishable `clientKey` to
`createStrybok` (enable "Links from the app" in the dashboard and list the allowed route patterns
there):

```ts
const link = await strybok.createLink('/product/42', {
  payload: { productId: 42 },
  title: 'Red shoes',
});
await Share.share({ message: link.url });
```

`createLink` rejects with a typed error (`StrybokUnauthorizedError`, `RouteNotAllowedError`,
`StrybokRateLimitedError`, `StrybokValidationError`, `StrybokNetworkError`, `StrybokTimeoutError`,
`StrybokServerError`), never runs during start-up and works without `initialize()`.

Full guide, native setup (bare React Native and Expo) and troubleshooting:
[`docs/react-native.md`](../../docs/react-native.md).

- **Early release (0.x)**: covered by unit tests with fake `Linking` and fake hooks only. It
  has not been run inside a real React Native or Expo app, nor on a physical device.
- Deferred deep linking is not supported.

## Install

```sh
npm install @strybok/react-native
```

## Development

From the repository root, after `pnpm install`:

```sh
pnpm --filter @strybok/react-native lint
pnpm --filter @strybok/react-native typecheck
pnpm --filter @strybok/react-native test
pnpm --filter @strybok/js --filter @strybok/react-native build   # ESM + .d.ts into dist/
```

`react` and `react-native` are peer dependencies and are not installed in this repository; see
[`peer-stubs/README.md`](./peer-stubs/README.md).

## Licence

Apache 2.0, see [LICENSE](./LICENSE).
