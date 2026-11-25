/**
 * Strybok SDK for React Native and Expo.
 *
 * A thin adapter over `@strybok/js`: links come from React Native's `Linking` module, the
 * platform from `Platform.OS`. Pure JavaScript, no native module.
 *
 * Deferred links (restoring a link after the app is installed from a store) are optional and off
 * by default (`deferredLinks`). This package has no native code and no store integration: the
 * app supplies the install referrer (`installReferrerSources`), the pasted text on iOS
 * (`redeemPastedLink`) and a persistent store (`deferredLinkStore`); without the store the
 * feature stays disabled.
 */
import { useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';
import type { LinkSource, Strybok } from '@strybok/js';
import { createStrybokWith, type ReactNativeStrybokOptions } from './factory.js';
import { createUseStrybokLink, type UseStrybokLink } from './hook.js';
import { createLinkingSource } from './link-source.js';

export * from '@strybok/js';
export { REACT_NATIVE_SDK_VERSION } from './factory.js';
export type { ReactNativeStrybokOptions } from './factory.js';
export { createLinkingSource } from './link-source.js';
export type { LinkingLike } from './link-source.js';
export type { StrybokLike, UseStrybokLink } from './hook.js';

/**
 * Creates the SDK for this app. Create it once, outside of components, and keep it for the
 * lifetime of the app.
 *
 * ```ts
 * export const strybok = createStrybok({
 *   apiBaseUrl: 'https://api.strybok.com',
 *   allowedHosts: ['my-app.strybok.link'],
 * });
 * ```
 */
export function createStrybok(options: ReactNativeStrybokOptions): Strybok {
  return createStrybokWith({ Linking, Platform }, options);
}

/** A `LinkSource` backed by React Native's `Linking` module (what `createStrybok` uses). */
export function reactNativeLinkSource(): LinkSource {
  return createLinkingSource(Linking);
}

/**
 * Subscribes a component to resolved links and starts the SDK.
 *
 * `onLink` receives every link exactly once, including the one that cold-started the app. The
 * latest `onLink` is always the one called; the subscription itself only changes with `strybok`.
 *
 * ```tsx
 * useStrybokLink(strybok, (link) => openRoute(link.routePath, link.payload));
 * ```
 */
export const useStrybokLink: UseStrybokLink = createUseStrybokLink({ useEffect, useRef });
