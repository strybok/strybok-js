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
