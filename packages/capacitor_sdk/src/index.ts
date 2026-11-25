/**
 * Strybok SDK for Capacitor and Ionic.
 *
 * A thin adapter over `@strybok/js`: links come from the `@capacitor/app` plugin, the platform
 * from `Capacitor.getPlatform()`, and requests go through `CapacitorHttp` on iOS and Android.
 *
 * Deferred links (restoring a link after the app is installed from a store) are optional and off
 * by default (`deferredLinks`). This package has no native code and no store integration: the
 * app supplies the install referrer (`installReferrerSources`), the pasted text on iOS
 * (`redeemPastedLink`) and a persistent store (`deferredLinkStore`); without the store the
 * feature stays disabled.
 */
import { App } from '@capacitor/app';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { FetchLike, LinkSource, Strybok } from '@strybok/js';
import { createStrybokWith, type CapacitorStrybokOptions } from './factory.js';
import { createCapacitorHttpFetch } from './http.js';
import { createCapacitorLinkSource } from './link-source.js';

export * from '@strybok/js';
export { CAPACITOR_SDK_VERSION } from './factory.js';
export type { CapacitorStrybokOptions } from './factory.js';
export { createCapacitorHttpFetch } from './http.js';
export type { CapacitorHttpLike } from './http.js';
export { createCapacitorLinkSource } from './link-source.js';
export type { CapacitorAppLike, ListenerHandleLike } from './link-source.js';

/**
 * Creates the SDK for this app. Create it once, at start-up, and keep it for the lifetime of the
 * app.
 *
 * ```ts
 * export const strybok = createStrybok({
 *   apiBaseUrl: 'https://api.strybok.com',
 *   allowedHosts: ['my-app.strybok.link'],
 * });
 * strybok.onLink((link) => router.push(link.routePath));
 * await strybok.initialize();
 * ```
 */
export function createStrybok(options: CapacitorStrybokOptions): Strybok {
  return createStrybokWith({ App, Capacitor, CapacitorHttp }, options);
}

/** A `LinkSource` backed by the `@capacitor/app` plugin (what `createStrybok` uses). */
export function capacitorLinkSource(): LinkSource {
  return createCapacitorLinkSource(App);
}

/**
 * The native HTTP transport `createStrybok` uses on iOS and Android, or `undefined` when this
 * version of `@capacitor/core` has no `CapacitorHttp`.
 */
export function capacitorHttpFetch(): FetchLike | undefined {
  return CapacitorHttp ? createCapacitorHttpFetch(CapacitorHttp) : undefined;
}
