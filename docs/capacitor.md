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
> Deferred links (a link tapped before the app is installed, restored after installation) are
> **optional, off by default and not verified on a device**. This package has no native code and
> no store integration: your app supplies the install referrer (Android), the text the person
> pasted (iOS) and a persistent store. See [Deferred links](#deferred-links-optional).

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

### Campaign values

Every link you receive has `campaign`: an object with the optional strings `source`, `medium`,
`campaign`, `term` and `content` (type `LinkCampaign`). It is never `null`; a value that is not
set is absent, and the object is empty when there are none.

```ts
strybok.onLink((link) => {
  analytics.track('link_opened', {
    source: link.campaign.source, // 'instagram', or undefined
    campaign: link.campaign.campaign,
  });
  openLink(link.routePath, link.payload);
});
```

- **Where the values come from.** A link can have default values, set per link in the dashboard
  ("Campaign (optional)" in the link form). The `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term` and `utm_content` parameters of the URL that was tapped override them one by one:
  if the link's default source is `newsletter`,
  `https://my-app.strybok.link/invite777?utm_source=instagram` arrives with the source
  `instagram` and the link's other defaults. A parameter can replace a default but
  not clear it.
- **Which values are accepted.** 1–64 characters of letters, digits, `.`, `_`, `~` and `-`.
  Anything else (a space, `+`, letters outside ASCII) is dropped as if the parameter were absent,
  without an error: write `spring_sale`, not `spring sale`.
- **They are untrusted labels.** Whoever shares a link can put any `utm_*` values on it. Use them
  for attribution, never to grant anything or to decide what the user may see.
- **What is sent.** Of the tapped URL's query only these five parameters are sent when resolving,
  and the resolved values are reported with the `app_open` event (section "Analytics and
  privacy"); every other parameter and the fragment stay on the device. In the dashboard, a link's analytics has a "Campaigns" breakdown of opens
  by source, medium and campaign.

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
`dedupeWindowMs`, `reportAppOpens`, `onError`, `clientKey` (for `createLink`, section 5), the
[deferred-link options](#deferred-links-optional) (all off or empty by default), plus `fetch`, `linkSource` and `platform` to
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

`routePath`, `payload` and `campaign` are data from the network. Match the route against routes
your app knows before navigating (as `toAppPath` does above), and never execute payload contents
or campaign values: in a WebView that includes never inserting them as HTML. Campaign values are
labels only.

## 7. Links that arrive before sign-in

If a link needs an authenticated user, remember the route and open it after login instead of
dropping it.

## 8. Analytics and privacy

After a link is delivered the SDK sends one best-effort `app_open` event
(`POST /v1/public/events`) containing a random event id, the link id, the platform
(`ios`/`android`), the SDK version (`0.3.0+capacitor`) and the link's campaign values when it has
any, and no device identifiers. It never
delays navigation and all failures are ignored. Disable it with `reportAppOpens: false`.

Only the link's host and slug are sent to `resolve`, plus the five `utm_*` campaign parameters of
the tapped URL when their value passes the character rule
([Campaign values](#campaign-values)). Every other query parameter and the fragment stay on the
device.

With `deferredLinks` switched on, the SDK additionally sends what
[Deferred links](#deferred-links-optional) describes: the click id from the install referrer or
from the pasted link together with your app identifier, or — only with
`allowProbabilisticMatching` — the bundle id, device family and language, which the server
combines with the connection's IP address.

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

## Deferred links (optional)

A person taps a link, does not have the app, installs it and opens it: with deferred links the
app can still receive that link. It is **off by default**, very different on Android and iOS,
and **not verified on a device**. Start with the platform guides — what the owner switches on,
what visitors see and what it costs:
[Android](./android.md#links-tapped-before-the-app-is-installed-deferred-links),
[iOS](./ios.md#links-tapped-before-the-app-is-installed). The options, results and status values
are described once, in the [JavaScript core guide](./javascript.md#deferred-links-optional).

**`@strybok/capacitor` ships no native plugin and no store integration of its own.** It runs the
logic; your app supplies

- a persistent store (`deferredLinkStore`: `getItem`/`setItem`). `@capacitor/app` and
  `@capacitor/core`, the only plugins this package depends on, have none; the Preferences
  plugin is a separate package that this SDK does not add. Without a store the feature stays
  `disabled`; the SDK never keeps this state only in memory. (The WebView's `localStorage` has
  the right shape, but the OS may clear it, which would let the check run again.);
- on Android: `androidPackageName` and at least one install referrer source;
- on iOS: `iosBundleId` and the text the person pasted.

```ts
import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences'; // if your app has this plugin
import { createStrybok, type InstallReferrerAnswer } from '@strybok/capacitor';

// Your own plugin, see below.
const InstallReferrer = registerPlugin<{ get(): Promise<InstallReferrerAnswer> }>(
  'InstallReferrer',
);

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  deferredLinks: true, // or strybok.enableDeferredLinks() after a consent screen
  deferredLinkStore: {
    getItem: async (key) => (await Preferences.get({ key })).value,
    setItem: (key, value) => Preferences.set({ key, value }),
  },
  androidPackageName: 'com.example.app',
  installReferrerSources: [() => InstallReferrer.get()],
  iosBundleId: 'com.example.App',
});
```

A restored link arrives in `onLink` with `isDeferred: true`, never from `getInitialLink()`. The
requests are sent natively like all others.

### Android: obtaining the Play install referrer

**Example of app-side code, not part of the SDK and not run by us.** We could not verify a
community plugin for this, so the example is a local plugin of your own. Add Google's library
to `android/app/build.gradle`:

```groovy
dependencies {
  implementation "com.android.installreferrer:installreferrer:2.2"
}
```

```kotlin
// android/app/src/main/java/.../InstallReferrerPlugin.kt
// Register it in MainActivity: registerPlugin(InstallReferrerPlugin::class.java)
@CapacitorPlugin(name = "InstallReferrer")
class InstallReferrerPlugin : Plugin() {
  @PluginMethod
  fun get(call: PluginCall) {
    val client = InstallReferrerClient.newBuilder(context).build()
    val answered = AtomicBoolean(false)
    fun answer(status: String, referrer: String? = null) {
      if (!answered.compareAndSet(false, true)) return
      try { client.endConnection() } catch (_: Exception) {}
      val result = JSObject().put("status", status)
      if (referrer != null) result.put("referrer", referrer)
      call.resolve(result)
    }
    try {
      client.startConnection(object : InstallReferrerStateListener {
        override fun onInstallReferrerSetupFinished(code: Int) {
          when (code) {
            InstallReferrerClient.InstallReferrerResponse.OK ->
              try {
                answer("referrer", client.installReferrer.installReferrer ?: "")
              } catch (_: Exception) {
                answer("unavailableForNow") // RemoteException
              }
            InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED,
            InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR ->
              answer("unavailable")
            else -> answer("unavailableForNow") // SERVICE_UNAVAILABLE, SERVICE_DISCONNECTED
          }
        }
        override fun onInstallReferrerServiceDisconnected() = answer("unavailableForNow")
      })
    } catch (_: Exception) {
      answer("unavailableForNow")
    }
  }
}
```

The SDK reads only `strybok_click` from the string and sends only that id, your package name and
the SDK version. A source that rejects or takes longer than 10 seconds counts as "unavailable
for now"; the check is repeated on a later launch, at most three times per installation.
Sources for Huawei AppGallery and Samsung Galaxy Store can be added to the list in the same
way, but those flows are **unverified even in the native Strybok SDKs**.

### iOS: the paste step

Nothing is restored automatically on iOS. With the owner's "copy and paste the link" option
switched on, the visitor copies the link on a page before the App Store; your app offers a paste
step on its first screen or in onboarding and passes the text on. The SDK never reads the
clipboard. In a WebView the simplest honest form is a field the person pastes into with the
system's own Paste command:

```ts
// <input id="paste-link" placeholder="Paste the link you copied" />
document.querySelector('#paste-link')!.addEventListener('paste', async (event) => {
  const text = (event as ClipboardEvent).clipboardData?.getData('text') ?? '';
  const result = await strybok.redeemPastedLink(text);
  if (result === 'notOurs') showHint('That is not a link to this app.');
  // 'delivered': the link arrives in onLink.
});
```

A `paste` event is started by the person, so there is no clipboard read behind their back
(to our understanding the WebView shows no permission prompt for it — unverified on a device).
Alternatives: a native view with Apple's `UIPasteControl` (iOS 16 or later) in a plugin of your
own, or a "Paste" button that reads the clipboard through a clipboard plugin, which makes iOS
show its paste prompt. Never read the clipboard at launch, say next to the field what it does,
and describe it in your App Review notes. The cost of this option: every iOS visitor without
the app sees an extra page and makes an extra tap before the App Store, and only the people who
then paste get their link.

### iOS: probabilistic matching (not recommended)

`allowProbabilisticMatching: true` lets the server guess the link from the network address on
the first launch. It additionally needs two callbacks:

```ts
createStrybok({
  // ...
  deferredLinks: true,
  allowProbabilisticMatching: true,
  // 'iphone' | 'ipad' | 'ipod'. From the WebView's user agent; an iPad whose WebView presents
  // itself as a Mac gives null, and the check ends with `unavailable`.
  deviceFamily: () => /\b(iPhone|iPad|iPod)\b/.exec(navigator.userAgent)?.[1]?.toLowerCase(),
  // The person's first preferred language as a BCP 47 tag, e.g. "en-GB".
  locale: () => navigator.language,
});
```

State plainly to whoever decides this:

- **Apple's rules forbid it** (App Store Review Guidelines and the Developer Program License
  Agreement: no deriving data from a device to identify it, with or without consent). The App
  Review and legal risk is the app owner's.
- **Wrong matches happen** on shared networks: the link may be another person's. Such a link
  has `isProbabilisticMatch: true` — never sign in, accept an invitation, apply a personal
  discount or show personal content because of it.
- It does not work with iCloud Private Relay or a VPN.
- The service processes IP addresses for it: privacy policy and App Store privacy labels must
  say so, and consent may be needed.
- It needs the owner's setting and a per-link opt-in, and its accuracy is unknown.

Details and the full list of costs: [iOS guide](./ios.md#option-not-recommended-probabilistic-matching-iosdeferredmatching).

`strybok.deferredLinkStatus` (and `onDeferredLinkStatus`) tells you during development what the
check did; see the [status table](./javascript.md#status).

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
