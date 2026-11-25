# React Native and Expo integration

`@strybok/react-native` receives verified HTTPS links through React Native's
[`Linking`](https://reactnative.dev/docs/linking) module, asks the Strybok API which in-app route
a link stands for, and hands your app each link exactly once.

It is a thin adapter over the JavaScript core ([`@strybok/js`](./javascript.md)): pure
JavaScript, no native module, so there is nothing to link and no Expo config plugin to add.

> **Status:** covered by unit tests that use a fake `Linking` module and a fake hooks runtime.
> It has **not** been run inside a real React Native or Expo app and not on a physical device
> (see the [manual test plan](./manual-test-plan.md)); treat 0.x as an early release.
> The native snippets below follow the React Native and Expo documentation; verify them against
> the versions you use.
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

## 2. Add the package

```sh
npm install @strybok/react-native
```

Peer dependencies: `react` and `react-native` 0.65 or newer (the SDK also falls back to the older
`Linking.removeEventListener`). The packages are ESM with an `exports` map; Metro resolves the
main entry through `main` in any case.

## 3. Native setup

The association files (`apple-app-site-association`, `assetlinks.json`) are served by Strybok;
see the [iOS](./ios.md) and [Android](./android.md) guides for how to check them and how to
verify on a device. What differs per project type is where the app-side declaration goes.

### Expo (development builds and EAS Build)

`app.json` (or the same keys in `app.config.js`):

```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.example.myapp",
      "associatedDomains": ["applinks:my-app.strybok.link"]
    },
    "android": {
      "package": "com.example.myapp",
      "intentFilters": [
        {
          "action": "VIEW",
          "autoVerify": true,
          "data": [{ "scheme": "https", "host": "my-app.strybok.link" }],
          "category": ["BROWSABLE", "DEFAULT"]
        }
      ]
    }
  }
}
```

- Declare the whole host, without a path: the slug is resolved at runtime.
- These keys change the native projects, so **rebuild** the app afterwards (`npx expo prebuild`
  for a local build, or a new EAS build). A JavaScript-only update does not apply them.
- **Expo Go cannot be used** to test this: Universal Links / App Links are bound to your own
  bundle identifier, package name and signing certificate. Use a development build.
- The bundle identifier, Apple Team ID, package name and the SHA-256 fingerprint of the
  certificate that signs the build (for EAS: `eas credentials`) must match what is configured in
  Strybok.

### Bare React Native

**iOS**

1. Add the Associated Domains capability with `applinks:my-app.strybok.link`
   ([iOS guide](./ios.md), step 2).
2. Forward Universal Links to React Native's `Linking` module. Without this, `Linking` never sees
   them. In `AppDelegate.swift`:

   ```swift
   override func application(
     _ application: UIApplication,
     continue userActivity: NSUserActivity,
     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
   ) -> Bool {
     return RCTLinkingManager.application(
       application,
       continue: userActivity,
       restorationHandler: restorationHandler
     )
   }
   ```

   or in an Objective-C `AppDelegate.mm`:

   ```objc
   #import <React/RCTLinkingManager.h>

   - (BOOL)application:(UIApplication *)application
       continueUserActivity:(nonnull NSUserActivity *)userActivity
         restorationHandler:(nonnull void (^)(NSArray<id<UIUserActivityRestoring>> *_Nullable))restorationHandler
   {
     return [RCTLinkingManager application:application
                      continueUserActivity:userActivity
                        restorationHandler:restorationHandler];
   }
   ```

   The exact signature depends on your React Native version and template; see
   [Linking: enabling deep links](https://reactnative.dev/docs/linking#enabling-deep-links).

**Android**

In `android/app/src/main/AndroidManifest.xml`, inside the `MainActivity` `<activity>`:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="my-app.strybok.link" />
</intent-filter>
```

Keep `android:launchMode="singleTask"` on `MainActivity` (the template's default), so that a link
opened while the app is running reaches the existing activity instead of starting a second one.

## 4. Use it

Create the SDK once, at module level, and subscribe from a component:

```tsx
// strybok.ts
import { createStrybok } from '@strybok/react-native';

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  onError: (error) => console.warn('Link failed', error),
});
```

```tsx
import { useStrybokLink } from '@strybok/react-native';
import { strybok } from './strybok';

function DeepLinks() {
  useStrybokLink(strybok, (link) => {
    // link.routePath === '/invite/abc123'
    // link.payload.invitationId === 'abc123'
    openRoute(link.routePath, link.payload);
  });
  return null;
}
```

`useStrybokLink` starts the SDK (`initialize()`), subscribes while the component is mounted and
always calls the latest callback. One subscription covers every case:

| Situation                                 | What happens                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Cold start** (app launched by the link) | The launch link is resolved and kept until the hook's component mounts, then delivered once. |
| **Background** (app resumed by the link)  | Delivered to the callback.                                                                   |
| **Foreground**                            | Delivered to the callback.                                                                   |

If React Native reports the same tap twice (as the initial URL _and_ as a `url` event), the
duplicate is dropped (`dedupeWindowMs`, 2 s by default). The same link tapped again later is a
new delivery. Links that arrive while the component is unmounted are queued for the next mount,
which also makes the hook safe under React StrictMode's double-invoked effects.

Without the hook, the same instance works anywhere:

```ts
const unsubscribe = strybok.onLink((link) => openRoute(link.routePath, link.payload));
await strybok.initialize();
// or: const link = await strybok.getInitialLink();
```

### React Navigation

Map `routePath` onto screens you already have, and mount the subscription only once the
navigation container is ready. Links are queued until then, so the cold-start link is not lost:

```tsx
import { useState } from 'react';
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { useStrybokLink, type ResolvedLink } from '@strybok/react-native';
import { strybok } from './strybok';

type RootStackParamList = {
  Home: undefined;
  Invite: { code: string };
  Settings: undefined;
};

const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Only routes listed here can be opened by a link. */
function openLink(link: ResolvedLink) {
  const invite = /^\/invite\/([A-Za-z0-9_-]{1,64})$/.exec(link.routePath);
  if (invite) {
    navigationRef.navigate('Invite', { code: invite[1] });
  } else if (link.routePath === '/settings') {
    navigationRef.navigate('Settings');
  }
  // Anything else: ignore, or show a "link not supported in this version" screen.
}

function DeepLinks() {
  useStrybokLink(strybok, openLink);
  return null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  return (
    <NavigationContainer ref={navigationRef} onReady={() => setReady(true)}>
      {ready && <DeepLinks />}
      <RootStack />
    </NavigationContainer>
  );
}
```

Do **not** also list the Strybok host in React Navigation's `linking.prefixes`. React Navigation
would try to interpret `/invite777` (the slug, not your route) as a path and navigate on its own,
in addition to the SDK. Custom schemes and your other domains can stay there; the SDK ignores
URLs that are not Strybok links of this app.

### Expo Router

Expo Router handles every incoming URL itself and would look for a route named after the slug.
Its `+native-intent` file exists for exactly this kind of third-party link. A sketch, **not
verified** against a real project:

```ts
// app/+native-intent.ts
import { strybok } from '../strybok';

export async function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (!strybok.isStrybokUrl(path)) return path;
  try {
    const link = await strybok.resolveUrl(path);
    return isKnownRoute(link.routePath) ? link.routePath : '/';
  } catch {
    return '/';
  }
}
```

`resolveUrl` does not report an `app_open` event and does not call listeners. If you use this
approach, do not also navigate from `useStrybokLink` / `onLink`.

### Campaign values

Every link you receive has `campaign`: an object with the optional strings `source`, `medium`,
`campaign`, `term` and `content` (type `LinkCampaign`). It is never `null`; a value that is not
set is absent, and the object is empty when there are none.

```tsx
useStrybokLink(strybok, (link) => {
  analytics.track('link_opened', {
    source: link.campaign.source, // 'instagram', or undefined
    campaign: link.campaign.campaign,
  });
  openLink(link);
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

`@strybok/react-native` re-exports everything from `@strybok/js`
([API, options and details](./javascript.md#api)) and adds:

| Export                            | Purpose                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `createStrybok(options)`          | A `Strybok` with `linkSource` from `Linking` and `platform` from `Platform.OS`. |
| `useStrybokLink(strybok, onLink)` | Hook: start the SDK and receive links while the component is mounted.           |
| `reactNativeLinkSource()`         | The `Linking`-backed `LinkSource`, if you construct `Strybok` yourself.         |
| `createLinkingSource(linking)`    | The same for any object shaped like `Linking` (tests).                          |

`createStrybok` takes the options of the core: `apiBaseUrl`, `allowedHosts`, `timeoutMs` (5000 per
attempt), `maxRetries` (2; only timeouts, network errors and 5xx are retried), `retryDelayMs`,
`dedupeWindowMs`, `reportAppOpens`, `onError`, `clientKey` (for `createLink`, section 5), the
[deferred-link options](#deferred-links-optional) (all off or empty by default), plus `fetch`, `linkSource` and `platform` for
tests.

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
import { createStrybok, StrybokRateLimitedError } from '@strybok/react-native';

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
    await Share.share({ message: link.url }); // Share from 'react-native'
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
your app knows before navigating (as `openLink` does above), never execute payload contents, and
treat campaign values as labels only.

## 7. Links that arrive before sign-in

If a link needs an authenticated user, remember the route and open it after login instead of
dropping it. Alternatively render the component that calls `useStrybokLink` only for signed-in
users: links are queued until it mounts.

## 8. Analytics and privacy

After a link is delivered the SDK sends one best-effort `app_open` event
(`POST /v1/public/events`) containing a random event id, the link id, the platform
(`ios`/`android`), the SDK version (`0.3.0+react-native`) and the link's campaign values when it has
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

`@strybok/react-native/testing` provides `FakeLinkSource`; pass it as `linkSource` together with a
fake `fetch`:

```ts
import { createStrybok } from '@strybok/react-native';
import { FakeLinkSource } from '@strybok/react-native/testing';

const source = new FakeLinkSource({ initialUrl: 'https://my-app.strybok.link/abc' });
const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  linkSource: source,
  fetch: async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({ linkId: 'link_1', appId: 'app_1', routePath: '/invite/abc123' }),
  }),
});

source.emit('https://my-app.strybok.link/other'); // a link while the app is running
```

Under Jest, the packages are ESM and have to be transformed like React Native itself: add
`@strybok` to the allowlist in `transformIgnorePatterns` of your Jest config.

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

**`@strybok/react-native` stays pure JavaScript: it ships no native module and no store
integration of its own.** It runs the logic; your app supplies

- a persistent store (`deferredLinkStore`: `getItem`/`setItem`) — React Native has none built
  in, so pass the one your app already uses. Without it the feature stays `disabled`; the SDK
  never keeps this state only in memory;
- on Android: `androidPackageName` and at least one install referrer source;
- on iOS: `iosBundleId` and the text the person pasted.

```ts
import { createStrybok, type InstallReferrerSource } from '@strybok/react-native';
import { NativeModules } from 'react-native';

// Your own native module, see below.
const playInstallReferrer: InstallReferrerSource = () => NativeModules.InstallReferrer.get();

export const strybok = createStrybok({
  apiBaseUrl: 'https://api.strybok.com',
  allowedHosts: ['my-app.strybok.link'],
  deferredLinks: true, // or strybok.enableDeferredLinks() after a consent screen
  deferredLinkStore: appStorage, // any object with getItem(key) and setItem(key, value)
  androidPackageName: 'com.example.app',
  installReferrerSources: [playInstallReferrer],
  iosBundleId: 'com.example.App',
});
```

A store shaped like AsyncStorage (`getItem`/`setItem` returning promises) can be passed as it
is; for anything else wrap it in those two functions. A restored link arrives in `onLink` /
`useStrybokLink` with `isDeferred: true`, never from `getInitialLink()`.

### Android: obtaining the Play install referrer

**Example of app-side code, not part of the SDK and not run by us.** We could not verify a
community package for this, so the example is a native module of your own (about 40 lines).
Add Google's library to `android/app/build.gradle`:

```groovy
dependencies {
  implementation "com.android.installreferrer:installreferrer:2.2"
}
```

```kotlin
// android/app/src/main/java/.../InstallReferrerModule.kt — register it in a ReactPackage.
class InstallReferrerModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  override fun getName() = "InstallReferrer"

  @ReactMethod
  fun get(promise: Promise) {
    val client = InstallReferrerClient.newBuilder(reactApplicationContext).build()
    val answered = AtomicBoolean(false)
    fun answer(status: String, referrer: String? = null) {
      if (!answered.compareAndSet(false, true)) return
      try { client.endConnection() } catch (_: Exception) {}
      promise.resolve(Arguments.createMap().apply {
        putString("status", status)
        if (referrer != null) putString("referrer", referrer)
      })
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

With Expo this needs a development build and a config plugin or a local Expo module that adds
the same code; it cannot work in Expo Go.

The SDK reads only `strybok_click` from the string and sends only that id, your package name and
the SDK version. A source that rejects or takes longer than 10 seconds counts as "unavailable
for now"; the check is repeated on a later launch, at most three times per installation.
Sources for Huawei AppGallery and Samsung Galaxy Store can be added to the list in the same
way, but those flows are **unverified even in the native Strybok SDKs**.

### iOS: the paste step

Nothing is restored automatically on iOS. With the owner's "copy and paste the link" option
switched on, the visitor copies the link on a page before the App Store; your app shows a paste
button on its first screen or in onboarding and passes the text on:

```tsx
const result = await strybok.redeemPastedLink(pastedText);
if (result === 'notOurs') showHint('That is not a link to this app.');
// 'delivered': the link arrives in onLink / useStrybokLink.
```

How to obtain `pastedText` is your app's choice; the SDK never reads the clipboard:

- **Recommended: Apple's paste control** (`UIPasteControl`, iOS 16 or later). Tapping it is the
  person's consent and no "Allow Paste" alert appears. React Native has no built-in component
  for it, so this is a small native view of your own that sends the pasted string to JavaScript.
- A "Paste" button of your own that reads the clipboard through whatever clipboard module your
  app uses. iOS then shows its "Allow Paste" prompt.

Never read the clipboard at launch. Say next to the button what it does, and describe it in
your App Review notes. The cost of this option: every iOS visitor without the app sees an extra
page and makes an extra tap before the App Store, and only the people who then paste get their
link.

### iOS: probabilistic matching (not recommended)

`allowProbabilisticMatching: true` lets the server guess the link from the network address on
the first launch. It additionally needs two callbacks, because this package has no native code:

```ts
createStrybok({
  // ...
  deferredLinks: true,
  allowProbabilisticMatching: true,
  // 'iphone' | 'ipad' | 'ipod'. `Platform.isPad` is React Native's; an iPod touch cannot be
  // told apart without native code and is simply not matched.
  deviceFamily: () => (Platform.OS === 'ios' && Platform.isPad ? 'ipad' : 'iphone'),
  // The person's first preferred language as a BCP 47 tag ("en-GB"), from your localisation
  // library or a native module (`Locale.preferredLanguages.first`).
  locale: () => preferredLanguage,
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

| Symptom                                                     | Check                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link opens the browser/store instead of the app             | Native association is not verified: see the [Android](./android.md) and [iOS](./ios.md) guides. The SDK is not involved yet at this point.                                        |
| Works in a release build, not in Expo Go                    | Expected: Expo Go cannot claim your domain. Use a development build.                                                                                                              |
| Changed `app.json`, nothing happens                         | `associatedDomains` / `intentFilters` need a new native build.                                                                                                                    |
| iOS: app opens but no link arrives                          | `RCTLinkingManager` forwarding of `continueUserActivity` is missing in `AppDelegate` (bare React Native).                                                                         |
| App opens but nothing happens                               | Host missing from `allowedHosts`; `onError` output; API reachable from the device? Is the component that calls `useStrybokLink` mounted?                                          |
| Screen opens twice, or an "unmatched route" screen appears  | The Strybok host is also in React Navigation's `linking.prefixes`, or Expo Router handles the URL too; or you navigate from both `getInitialLink()` and a listener of your own.   |
| The launch link is handled again after a JS reload          | `Linking.getInitialURL()` keeps returning the launch URL for the life of the process, and a reload creates a new SDK instance. Development only; keep one instance in production. |
| Works on tap in Notes/Messages, not from Instagram/Telegram | In-app browsers often do not hand links to apps. Users get the fallback page with a manual button.                                                                                |
