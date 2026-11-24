# @strybok/js

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

Full guide, including how to write a `LinkSource`:
[`docs/javascript.md`](../../docs/javascript.md). Behaviour is defined by
the [SDK contract](../../docs/sdk-contract.md).

- **Not published to npm yet**: covered by unit tests only; verification on physical devices is
  still pending.
- Deferred deep linking is not supported.

## Install

`npm install @strybok/js` will work only after publication. Until then, build a tarball from
`https://github.com/strybok/strybok-js` and install that:

```sh
git clone https://github.com/strybok/strybok-js
cd strybok-js
pnpm install && pnpm build
(cd packages/js_sdk && pnpm pack)   # writes strybok-js-0.1.0.tgz

# in your app
npm install /path/to/strybok-js/packages/js_sdk/strybok-js-0.1.0.tgz
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
