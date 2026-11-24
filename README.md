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

```sh
npm install @strybok/react-native   # React Native and Expo
npm install @strybok/capacitor      # Capacitor and Ionic
npm install @strybok/js             # other JavaScript runtimes
```

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
