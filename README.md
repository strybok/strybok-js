# Strybok JavaScript SDKs

[![@strybok/js](https://img.shields.io/npm/v/@strybok/js.svg?label=%40strybok%2Fjs)](https://www.npmjs.com/package/@strybok/js) [![@strybok/react-native](https://img.shields.io/npm/v/@strybok/react-native.svg?label=%40strybok%2Freact-native)](https://www.npmjs.com/package/@strybok/react-native) [![@strybok/capacitor](https://img.shields.io/npm/v/@strybok/capacitor.svg?label=%40strybok%2Fcapacitor)](https://www.npmjs.com/package/@strybok/capacitor) [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

Deep links for JavaScript apps: Universal Links / App Links resolved to an in-app route
and payload, each delivered exactly once.

| Package | For | Guide |
| --- | --- | --- |
| [`@strybok/js`](./packages/js_sdk) | Platform-neutral core; Cordova, NativeScript and other runtimes | [javascript.md](./docs/javascript.md) |
| [`@strybok/react-native`](./packages/react_native_sdk) | React Native and Expo | [react-native.md](./docs/react-native.md) |
| [`@strybok/capacitor`](./packages/capacitor_sdk) | Capacitor and Ionic | [capacitor.md](./docs/capacitor.md) |

All SDKs follow the same [contract](./docs/sdk-contract.md). Not verified on physical
devices. Deferred links (restoring a link tapped before the app was installed) are optional
and off by default from 0.3.0; these packages have no native code, so the app supplies the
store's install referrer on Android and the pasted link on iOS, where nothing is automatic.
None of it has run on a device.

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
