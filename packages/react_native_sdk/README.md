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
await Share.share({ message: link.url });
```

`createLink` rejects with a typed error (`StrybokUnauthorizedError`, `RouteNotAllowedError`,
`StrybokRateLimitedError`, `StrybokValidationError`, `StrybokNetworkError`, `StrybokTimeoutError`,
`StrybokServerError`), never runs during start-up and works without `initialize()`.

Full guide, native setup (bare React Native and Expo) and troubleshooting:
[`docs/react-native.md`](../../docs/react-native.md).

- **Early release (0.x)**: covered by unit tests with fake `Linking` and fake hooks only. It
  has not been run inside a real React Native or Expo app, nor on a physical device.
- Deferred links (restoring a link tapped before the app was installed) are optional, off by
  default and unverified on devices; see below.

## Deferred links (optional)

Off unless you pass `deferredLinks: true` (or call `enableDeferredLinks()` later, for example
after a consent screen). This package ships **no native code and no store integration of its
own**; the app supplies:

- `deferredLinkStore` — persistent storage with `getItem`/`setItem` (React Native has no built-in one). Required: without it
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
[`docs/react-native.md`](../../docs/react-native.md#deferred-links-optional).

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
