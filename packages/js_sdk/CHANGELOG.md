## 0.4.0

- Links without an API call, optional and off by default: the new option
  `parameterLinks: { payloadKeys: [...] }` (type `ParameterLinksOptions`), the value of
  `parameterLinks` in the application's integration guide (`GET /v1/apps/:appId/integration`).
  With it the SDK also accepts path links (`https://<host>/product/42?id=7`: a path of at most
  512 characters without `//`, dot segments or a reserved name such as `/.well-known/…` or
  `/favicon.ico`) and Firebase long links (`https://<host>/?link=…` with an `http(s)` deep link),
  in the automatic flow and in `resolveUrl`. It sends the path as received and, of the query,
  only the configured payload keys (first occurrence, 1–256 characters, no control characters,
  re-encoded) and the `utm_*` values; for a long link the deep link rebuilt from its scheme,
  host, path and payload keys, plus `apn` and `ibi`. Never the fragment or any other parameter.
- The delivered link has the `routePath` and `payload` of the server's answer, never the tapped
  path; `app_open` reports the answer's `linkId`. An address of the app's hosts that passes the
  rules but is no link reaches `onError` as `LinkNotFoundError`.
- An invalid option (more than 20 keys, a key twice, a key that is not 1–40 characters of
  `A-Z a-z 0-9 _ . -`, starts with `utm_` or is `st`, `sd`, `si` or `strybok_click`) makes the
  constructor throw a `TypeError`, like any invalid option. `parameterLinks` on the instance is
  the validated, frozen copy (`null` when the option is not set).
- Without the option nothing changes: only one-slug links are accepted and every request is
  exactly the one 0.3.0 sent. Deferred links accept only one-slug links with or without it, in
  the server's answer and in a pasted text.
- Tested against all shared test vectors of the SDK contract (75 URLs, 19 options).
  Unit-tested only: never run on a device or against the production API.

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
