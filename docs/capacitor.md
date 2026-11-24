# Capacitor and Ionic integration

`@strybok/capacitor` receives verified HTTPS links through the
[`@capacitor/app`](https://capacitorjs.com/docs/apis/app) plugin, asks the Strybok API which
in-app route a link stands for, and hands your app each link exactly once. It works with any web
framework inside Capacitor (Ionic with Angular, React or Vue, or none).

It is a thin adapter over the JavaScript core ([`@strybok/js`](./javascript.md)) and has no
native code of its own.

> **Status:** covered by unit tests that use fake `App` and `CapacitorHttp` plugins. It has
> **not** been run inside a real Capacitor app and not on a physical device (see the
> [manual test plan](./manual-test-plan.md)); treat 0.x as an early release. Verify the
> native behaviour described here against the Capacitor version you use.
>
> Deferred deep linking is **not supported**: a link tapped before the app is installed is not
> restored after installation.

## 1. Prerequisites

1. Create an application in Strybok with your iOS and Android identifiers.
2. Read its setup data: `GET /v1/apps/:appId/integration` returns the managed hostname (for
   example `my-app.strybok.link`) and ready-to-copy snippets.
3. Complete the native setup below (step 3). Without it the OS never delivers links to the app,
   and the SDK has nothing to receive.

## 2. Add the packages

```sh
npm install @strybok/capacitor @capacitor/app
npx cap sync
```

Peer dependencies: `@capacitor/core` and `@capacitor/app`, version 5 or newer.

## 3. Native setup

The association files are served by Strybok; the [iOS](./ios.md) and [Android](./android.md)
guides explain how to check them and how to verify on a device. In a Capacitor project the
app-side declarations go here:

**iOS**: open `ios/App/App.xcworkspace`, select the _App_ target → _Signing & Capabilities_ →
_+ Capability_ → _Associated Domains_, and add

```text
applinks:my-app.strybok.link
```

Capacitor's `AppDelegate` template already forwards Universal Links to the plugin
(`ApplicationDelegateProxy.shared.application(_:continue:restorationHandler:)`); if you replaced
the template's `AppDelegate`, keep that call.

**Android**: in `android/app/src/main/AndroidManifest.xml`, inside the main `<activity>`:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="my-app.strybok.link" />
</intent-filter>
```

Declare the whole host, without a path: the slug is resolved at runtime. Keep the template's
`android:launchMode="singleTask"`.

Both are native changes: rebuild and reinstall the app; a live-reload of the web code is not
enough.

## 4. Use it

Create the SDK once when the app starts:

```ts
// strybok.ts
import { createStrybok } from '@strybok/capacitor';

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  onError: (error) => console.warn('Link failed', error),
});
```

```ts
import { strybok } from './strybok';

strybok.onLink((link) => {
  // link.routePath === '/invite/abc123'
  // link.payload.invitationId === 'abc123'
  openLink(link.routePath, link.payload);
});
await strybok.initialize();
```

One listener covers every case:

| Situation                                 | What happens                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Cold start** (app launched by the link) | `initialize()` resolves the launch link. It is kept until a listener is attached, then delivered once. |
| **Background** (app resumed by the link)  | Delivered to the listeners.                                                                            |
| **Foreground**                            | Delivered to the listeners.                                                                            |

The SDK listens to `appUrlOpen` first and then reads `App.getLaunchUrl()`. The launch URL
normally shows up in both; the duplicate is dropped (`dedupeWindowMs`, 2 s by default). The same
link tapped again later is a new delivery.

Prefer to read the launch link yourself? `await strybok.getInitialLink()` returns it at most once
and removes it from the queue, so combining both never navigates twice.

### Mapping routes to pages

Map `routePath` onto pages you already have; never pass it to the router unchecked.

```ts
/** Only routes listed here can be opened by a link. */
function toAppPath(routePath: string): string | null {
  const invite = /^\/invite\/([A-Za-z0-9_-]{1,64})$/.exec(routePath);
  if (invite) return `/invite/${invite[1]}`;
  if (routePath === '/settings') return '/settings';
  return null;
}
```

Vue Router (Ionic Vue), in `main.ts`:

```ts
router.isReady().then(() => {
  app.mount('#app');
  strybok.onLink((link) => {
    const path = toAppPath(link.routePath);
    if (path) void router.push(path);
  });
  void strybok.initialize();
});
```

Angular (Ionic Angular), in the root component. Plugin events arrive outside Angular's zone, so
navigate inside `NgZone.run`:

```ts
export class AppComponent {
  constructor(router: Router, zone: NgZone) {
    strybok.onLink((link) => {
      const path = toAppPath(link.routePath);
      if (path) zone.run(() => void router.navigateByUrl(path));
    });
    void strybok.initialize();
  }
}
```

React (Ionic React), in a component rendered inside the router:

```tsx
function DeepLinks() {
  const history = useHistory();
  useEffect(() => {
    const unsubscribe = strybok.onLink((link) => {
      const path = toAppPath(link.routePath);
      if (path) history.push(path);
    });
    void strybok.initialize();
    return unsubscribe;
  }, [history]);
  return null;
}
```

Links that arrive while no listener is attached are queued, so it is fine to attach the listener
only when the router is ready.

If you already have an `App.addListener('appUrlOpen', ...)` of your own that navigates, make it
ignore Strybok links (`strybok.isStrybokUrl(event.url)`), or the app navigates twice.

### Requests are sent natively

On iOS and Android the SDK sends its requests through `CapacitorHttp` (part of
`@capacitor/core`), not through the WebView's `fetch`. The reason is CORS: the web page of a
Capacitor app lives on `capacitor://localhost` or `https://localhost`, a WebView `fetch` to the
API is a cross-origin browser request that needs a CORS preflight. Native requests are not subject
to CORS. (The API's public SDK endpoints do allow any origin, so a WebView `fetch` works too once
your API deployment includes that change; native stays the default because it skips the preflight.)

- You do **not** need `CapacitorHttp: { enabled: true }` in `capacitor.config`; that setting
  patches the global `fetch`, while the SDK calls the plugin directly.
- Native requests cannot be aborted, so after a timeout the request may still finish in the
  background; its result is ignored.
- On the `web` platform (`ionic serve`, a PWA build) there are no Universal Links / App Links, the
  platform is reported as `unknown`, and the browser's `fetch` is used. `resolveUrl()` will then
  fail with `StrybokNetworkError` unless your origin is allowed by the API.
- `createLink()` goes the same way: natively on iOS and Android, with the `X-Strybok-Key` header.
- Pass your own `fetch` option to replace the transport.

### API

`@strybok/capacitor` re-exports everything from `@strybok/js`
([API, options and details](./javascript.md#api)) and adds:

| Export                           | Purpose                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `createStrybok(options)`         | A `Strybok` with `linkSource` from `@capacitor/app`, `platform` from `Capacitor.getPlatform()` and native HTTP. |
| `capacitorLinkSource()`          | The `@capacitor/app`-backed `LinkSource`, if you construct `Strybok` yourself.                                  |
| `capacitorHttpFetch()`           | The `CapacitorHttp`-backed transport, or `undefined` if `@capacitor/core` has none.                             |
| `createCapacitorLinkSource(app)` | The same link source for any object shaped like the `App` plugin (tests).                                       |
| `createCapacitorHttpFetch(http)` | The same transport for any object shaped like `CapacitorHttp` (tests).                                          |

`createStrybok` takes the options of the core: `apiBaseUrl`, `allowedHosts`, `timeoutMs` (5000 per
attempt), `maxRetries` (2; only timeouts, network errors and 5xx are retried), `retryDelayMs`,
`dedupeWindowMs`, `reportAppOpens`, `onError`, `clientKey` (for `createLink`, section 5), plus `fetch`, `linkSource` and `platform` to
override the defaults.

### Errors

`resolveUrl` rejects with, and `onError` receives, a `StrybokError` (for `createLink` see
section 5):

| Type                                          | Meaning                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnsupportedLinkError`                        | Not `https`, host not in `allowedHosts`, or not a single-slug path. Thrown before any network call. Ignored silently for links arriving from the OS. |
| `LinkNotFoundError`                           | Unknown, disabled or expired link.                                                                                                                   |
| `StrybokTimeoutError` / `StrybokNetworkError` | No answer after all retries (e.g. offline). The app keeps working; the link is simply not opened.                                                    |
| `StrybokServerError`                          | Unexpected status or malformed response (`statusCode`).                                                                                              |

Each error also has a string `kind` (`'link_not_found'`, `'timeout'`, ...) and the `url` it
belongs to.

## 5. Create a link to share

`createLink` asks the service for a short link to a screen of your app, for a "Share" button:

```ts
import { createStrybok, StrybokRateLimitedError } from '@strybok/capacitor';

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  clientKey: 'pk_...', // the application's publishable client key
});

async function shareProduct(productId: number) {
  try {
    const link = await strybok.createLink(`/product/${productId}`, {
      payload: { productId },
      title: 'Red shoes',
      description: 'Look at these',
      imageUrl: 'https://cdn.example.com/shoes.png',
    });
    await Share.share({ url: link.url }); // Share from '@capacitor/share'
  } catch (error) {
    if (error instanceof StrybokRateLimitedError) {
      // Try again later, after error.retryAfterSeconds when it is set.
    }
    // ...
  }
}
```

**Enable it first.** In the dashboard, open the application, switch on "Links from the app" and
list the route patterns the app may create links for. The page shows the publishable client key
(`pk_…`) to pass as `clientKey`. The key is safe to ship inside the app: it can only create links
for those route patterns. Never put a secret API key (`lb_…`) into an app.

- Only the route is required; `payload` (a JSON object), `title`, `description` and `imageUrl` are
  optional. The result has `url` (what the user shares), `slug`, `routePath` and `linkId`.
- Creating the same link again returns the existing link instead of making a second one.
- It runs only when you call it: it does not need `initialize()` and is never part of the app's
  start.
- Timeouts, network errors and 5xx are retried like resolving (`timeoutMs`, `maxRetries`,
  `retryDelayMs`); 4xx, including 429, never.

It rejects with a `StrybokError`; these errors never reach `onError` and never contain the client
key or the payload.

| Type                                          | Meaning                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `StrybokUnauthorizedError`                    | No `clientKey` configured (no request is made), or the key is wrong or was replaced, or the feature is switched off.          |
| `RouteNotAllowedError`                        | The route is not covered by the application's route patterns (`routePath`).                                                   |
| `StrybokRateLimitedError`                     | Too many requests, or the app's daily limit of new links is reached (`retryAfterSeconds`, when the service sent it).          |
| `StrybokValidationError`                      | The arguments were rejected by the SDK (route not starting with one `/`, payload not an object) or by the service (`issues`). |
| `StrybokTimeoutError` / `StrybokNetworkError` | No answer after all retries (e.g. offline).                                                                                   |
| `StrybokServerError`                          | Unexpected status or malformed response (`statusCode`).                                                                       |

Rate-limit, timeout, network and server errors are temporary: let the user try again later. The
other three do not go away by retrying; the app or the dashboard settings need a change. Details:
[JavaScript core, "Create a link to share"](./javascript.md#6-create-a-link-to-share).

## 6. Treat routes as untrusted input

`routePath` and `payload` are data from the network. Match the route against routes your app
knows before navigating (as `toAppPath` does above), and never execute payload contents: in a
WebView that includes never inserting them as HTML.

## 7. Links that arrive before sign-in

If a link needs an authenticated user, remember the route and open it after login instead of
dropping it.

## 8. Analytics and privacy

After a link is delivered the SDK sends one best-effort `app_open` event
(`POST /v1/public/events`) containing a random event id, the link id, the platform
(`ios`/`android`) and the SDK version (`0.2.0+capacitor`), and no device identifiers. It never
delays navigation and all failures are ignored. Disable it with `reportAppOpens: false`.

Only the link's host and slug are sent to `resolve`; query parameters and fragments stay on the
device.

## 9. Testing your integration

`@strybok/capacitor/testing` provides `FakeLinkSource`; pass it as `linkSource` together with a
fake `fetch`, and no Capacitor plugin is touched:

```ts
import { createStrybok } from '@strybok/capacitor';
import { FakeLinkSource } from '@strybok/capacitor/testing';

const source = new FakeLinkSource({ initialUrl: 'https://my-app.strybok.link/abc' });
const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource: source,
  platform: 'ios',
  fetch: async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({ linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' }),
  }),
});

source.emit('https://my-app.strybok.link/other'); // a link while the app is running
```

On a device or simulator you can simulate a tap:

```sh
# iOS simulator
xcrun simctl openurl booted "https://my-app.strybok.link/<slug>"

# Android
adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE \
  -d "https://my-app.strybok.link/<slug>"
```

## Troubleshooting

| Symptom                                                     | Check                                                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link opens the browser/store instead of the app             | Native association is not verified: see the [Android](./android.md) and [iOS](./ios.md) guides. The SDK is not involved yet at this point.               |
| App opens but nothing happens                               | `@capacitor/app` installed and `npx cap sync` run? Host missing from `allowedHosts`? What does `onError` report?                                         |
| `StrybokNetworkError` for every link                        | Requests are going through the WebView (CORS): a custom `fetch` option, the `web` platform, or a `@capacitor/core` without `CapacitorHttp` (before 4.1). |
| Page opens twice                                            | Another `appUrlOpen` listener also navigates, or two `Strybok` instances exist.                                                                          |
| Angular: URL changes but the view does not update           | Navigate inside `NgZone.run` (see above).                                                                                                                |
| The launch link is handled again after a live reload        | `App.getLaunchUrl()` keeps returning the launch URL for the life of the process, and a reload creates a new SDK instance. Development only.              |
| Works on tap in Notes/Messages, not from Instagram/Telegram | In-app browsers often do not hand links to apps. Users get the fallback page with a manual button.                                                       |
