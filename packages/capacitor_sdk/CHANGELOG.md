## 0.2.0

- `createLink` and its errors from `@strybok/js` 0.2.0: create a short link to share. Pass the
  application's publishable key as `clientKey` to `createStrybok`. On iOS and Android the request
  is sent through `CapacitorHttp`, like resolving.
- The `CapacitorHttp` transport passes response headers on (needed for `Retry-After`).

## 0.1.0

- Initial version: `createStrybok` (links from `@capacitor/app`, platform from
  `Capacitor.getPlatform()`, native HTTP through `CapacitorHttp` on iOS and Android),
  `capacitorLinkSource` / `createCapacitorLinkSource`, `capacitorHttpFetch` /
  `createCapacitorHttpFetch`, and the whole `@strybok/js` API re-exported; `FakeLinkSource` in
  `@strybok/capacitor/testing`.
