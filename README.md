# Strybok JavaScript SDKs

Deep links for JavaScript apps: Universal Links / App Links resolved to an in-app route
and payload, each delivered exactly once.

| Package | For | Guide |
| --- | --- | --- |
| [`@strybok/js`](./packages/js_sdk) | Platform-neutral core; Cordova, NativeScript and other runtimes | [javascript.md](./docs/javascript.md) |
| [`@strybok/react-native`](./packages/react_native_sdk) | React Native and Expo | [react-native.md](./docs/react-native.md) |
| [`@strybok/capacitor`](./packages/capacitor_sdk) | Capacitor and Ionic | [capacitor.md](./docs/capacitor.md) |

All SDKs follow the same [contract](./docs/sdk-contract.md). Not verified on physical
devices. Deferred deep linking is not supported.

## Install

The packages are **not published to npm yet**. Until they are, build tarballs from this
repository (Node.js 22+ and pnpm) and install those in your app:

```sh
git clone https://github.com/strybok/strybok-js
cd strybok-js
pnpm install && pnpm build
(cd packages/js_sdk && pnpm pack)             # strybok-js-0.1.0.tgz
(cd packages/react_native_sdk && pnpm pack)   # strybok-react-native-0.1.0.tgz
(cd packages/capacitor_sdk && pnpm pack)      # strybok-capacitor-0.1.0.tgz
```

`@strybok/react-native` and `@strybok/capacitor` depend on `@strybok/js`, so install the
core tarball together with the adapter tarball in one `npm install` command. Each guide
has the exact lines.

## Development

```sh
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

`packages/config` holds the shared TypeScript and ESLint settings; it is not an SDK.

## Licence

Apache 2.0, see [LICENSE](./LICENSE).
