## 0.4.0

- Links without an API call from `@strybok/js` 0.4.0, optional and off by default: pass
  `parameterLinks: { payloadKeys: [...] }` (the value of `parameterLinks` in the application's
  integration guide) to `createStrybok`, and path links (`https://<host>/product/42?id=7`) and
  Firebase long links (`https://<host>/?link=…`) are delivered with the route and payload the
  server read. Of the query only the configured keys and the `utm_*` values are sent; an invalid
  option makes `createStrybok` throw. Without the option nothing changes. Unit-tested only; never
  run on a device.

## 0.3.0

- Campaign values from `@strybok/js` 0.3.0: a resolved link has `campaign` (`LinkCampaign`, the
  optional strings `source`, `medium`, `campaign`, `term`, `content`; empty when there are none).
  The five `utm_*` parameters of the tapped URL are sent when resolving, nothing else of the
  query is, and the `app_open` event reports the resolved values. Nothing to change in app code.
- Deferred links from `@strybok/js` 0.3.0, optional and off by default (`deferredLinks`,
  `enableDeferredLinks()`, `redeemPastedLink`, `deferredLinkStatus`; `isDeferred` and
  `isProbabilisticMatch` on every resolved link). This package adds no native code and no store
  integration: the app passes a persistent `deferredLinkStore` (without it the feature stays
  `disabled`), the install referrer sources and `androidPackageName` on Android, `iosBundleId`
  and the pasted text on iOS. The platform comes from the adapter as before. Unit-tested only.

## 0.2.0

- `createLink` and its errors from `@strybok/js` 0.2.0: create a short link to share. Pass the
  application's publishable key as `clientKey` to `createStrybok`.

## 0.1.0

- Initial version: `createStrybok` (links from `Linking`, platform from `Platform.OS`), the
  `useStrybokLink` hook, `reactNativeLinkSource` / `createLinkingSource`, and the whole
  `@strybok/js` API re-exported; `FakeLinkSource` in `@strybok/react-native/testing`.
