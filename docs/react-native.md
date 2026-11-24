# React Native and Expo integration

`@strybok/react-native` receives verified HTTPS links through React Native's
[`Linking`](https://reactnative.dev/docs/linking) module, asks the Strybok API which in-app route
a link stands for, and hands your app each link exactly once.

It is a thin adapter over the JavaScript core ([`@strybok/js`](./javascript.md)): pure
JavaScript, no native module, so there is nothing to link and no Expo config plugin to add.

> **Status:** covered by unit tests that use a fake `Linking` module and a fake hooks runtime.
> It has **not** been run inside a real React Native or Expo app and not on a physical device
> (see the [manual test plan](./manual-test-plan.md)); treat 0.1.x as an early release.
> The native snippets below follow the React Native and Expo documentation; verify them against
> the versions you use.
>
> Deferred deep linking is **not supported**: a link tapped before the app is installed is not
> restored after installation.

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
`dedupeWindowMs`, `reportAppOpens`, `onError`, plus `fetch`, `linkSource` and `platform` for
tests.

### Errors

`resolveUrl` rejects with, and `onError` receives, a `StrybokError`:

| Type                                          | Meaning                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnsupportedLinkError`                        | Not `https`, host not in `allowedHosts`, or not a single-slug path. Thrown before any network call. Ignored silently for links arriving from the OS. |
| `LinkNotFoundError`                           | Unknown, disabled or expired link.                                                                                                                   |
| `StrybokTimeoutError` / `StrybokNetworkError` | No answer after all retries (e.g. offline). The app keeps working; the link is simply not opened.                                                    |
| `StrybokServerError`                          | Unexpected status or malformed response (`statusCode`).                                                                                              |

Each error also has a string `kind` (`'link_not_found'`, `'timeout'`, ...) and the `url` it
belongs to.

## 5. Treat routes as untrusted input

`routePath` and `payload` are data from the network. Match the route against routes your app
knows before navigating (as `openLink` does above), and never execute payload contents.

## 6. Links that arrive before sign-in

If a link needs an authenticated user, remember the route and open it after login instead of
dropping it. Alternatively render the component that calls `useStrybokLink` only for signed-in
users: links are queued until it mounts.

## 7. Analytics and privacy

After a link is delivered the SDK sends one best-effort `app_open` event
(`POST /v1/public/events`) containing a random event id, the link id, the platform
(`ios`/`android`) and the SDK version (`0.1.0+react-native`), and no device identifiers. It never
delays navigation and all failures are ignored. Disable it with `reportAppOpens: false`.

Only the link's host and slug are sent to `resolve`; query parameters and fragments stay on the
device.

## 8. Testing your integration

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
