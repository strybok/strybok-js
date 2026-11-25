## 0.3.0

- Campaign values. A resolved link has `campaign` (type `LinkCampaign`): the optional strings
  `source`, `medium`, `campaign`, `term` and `content`. It is never `null` and is an empty object
  when the link has none. The values are the link's defaults, overridden by the `utm_*`
  parameters of the URL that was tapped; treat them as untrusted labels.
- Resolving now sends the five `utm_*` parameters of the tapped URL (`utm_source`, `utm_medium`,
  `utm_campaign`, `utm_term`, `utm_content`) when their value is 1–64 characters of
  `A-Z a-z 0-9 . _ ~ -`. Every other query parameter and the fragment are still never sent, and
  a URL without such a parameter produces exactly the request of 0.2.0.
- The `app_open` event carries the `campaign` that resolving returned; it is left out when empty.
- Deferred links, optional and off by default (`deferredLinks`, or `enableDeferredLinks()` after
  start): restore a link that was tapped before the app was installed. The package has no native
  code, so the app supplies a persistent `deferredLinkStore` (required; without it the status is
  `disabled`), on Android `androidPackageName` and `installReferrerSources` (functions returning
  the store's install referrer), on iOS `iosBundleId` and the pasted text for
  `redeemPastedLink(text)`. `allowProbabilisticMatching` (iOS, with `deviceFamily` and `locale`
  callbacks, optionally `pasteboardMayContainLink` and `skipPastedLink()`) is off by default and
  forbidden by Apple's rules. New: `deferredLinkStatus`, `onDeferredLinkStatus`, the types
  `DeferredLinkStatus`, `PastedLinkResult`, `InstallReferrerSource`, `InstallReferrerAnswer`,
  `DeferredLinkStore`. A deferred link is delivered through `onLink` at most once per
  installation, never by `getInitialLink()`, without an `app_open` event, and is dropped when a
  normal link arrived first. Unit-tested only; not verified on a device.
- Every `ResolvedLink` has `isDeferred` and `isProbabilisticMatch` (`false` unless the link was
  restored after an installation, or guessed by probabilistic matching).
- Not source-breaking for apps. Code that builds a `ResolvedLink` object itself (a test double,
  for example) has to add `campaign: {}`, `isDeferred: false` and `isProbabilisticMatch: false`.

## 0.2.0

- `createLink(routePath, { payload, title, description, imageUrl })` creates a short link to
  share and resolves with `{ url, slug, routePath, linkId }`. It needs the new `clientKey` option
  (the application's publishable key), runs only when called and works without `initialize()`.
  Timeouts, network errors and 5xx are retried with an identical request.
- New errors: `StrybokUnauthorizedError`, `RouteNotAllowedError` (`routePath`),
  `StrybokRateLimitedError` (`retryAfterSeconds`), `StrybokValidationError` (`statusCode`,
  `issues`); new kinds `unauthorized`, `route_not_allowed`, `rate_limited`, `validation`.
- `FetchResponseLike` may have `headers` (`get(name)`); only `Retry-After` is read. Transports
  without it keep working.

## 0.1.0

- Initial version: `Strybok` with `initialize`, `onLink`, `getInitialLink`, `resolveUrl`,
  `isStrybokUrl`, `dispose`; pluggable `LinkSource` and `fetch`; host allowlist with a strict
  built-in URL parser; duplicate-delivery protection; timeout (AbortController) and retry; typed
  errors; best-effort `app_open` events; `FakeLinkSource` test helper in `@strybok/js/testing`.
