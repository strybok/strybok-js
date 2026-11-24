import { SDK_VERSION, Strybok, type StrybokOptions } from '@strybok/js';
import { createCapacitorHttpFetch, type CapacitorHttpLike } from './http.js';
import { createCapacitorLinkSource, type CapacitorAppLike } from './link-source.js';
import { toStrybokPlatform, type CapacitorLike } from './platform.js';

/** Sent with `app_open` events: the core version plus the adapter name. */
export const CAPACITOR_SDK_VERSION = `${SDK_VERSION}+capacitor`;

/**
 * Options of {@link Strybok}, with the Capacitor parts filled in: `linkSource` defaults to the
 * `@capacitor/app` plugin, `platform` to `Capacitor.getPlatform()`, and `fetch` to native HTTP
 * (`CapacitorHttp`) on iOS and Android. All three can still be overridden (tests do).
 */
export type CapacitorStrybokOptions = Omit<
  StrybokOptions,
  'linkSource' | 'platform' | 'sdkVersion'
> &
  Partial<Pick<StrybokOptions, 'linkSource' | 'platform'>>;

export interface CapacitorModules {
  readonly App: CapacitorAppLike;
  readonly Capacitor: CapacitorLike;
  readonly CapacitorHttp?: CapacitorHttpLike | undefined;
}

/** {@link createStrybok} with the Capacitor modules passed in. */
export function createStrybokWith(
  modules: CapacitorModules,
  options: CapacitorStrybokOptions,
): Strybok {
  const platform = options.platform ?? toStrybokPlatform(readPlatform(modules.Capacitor));
  const http = modules.CapacitorHttp;
  // In the WebView the API's CORS policy applies and blocks the request; go native where we can.
  const nativeFetch =
    platform !== 'unknown' &&
    http !== undefined &&
    http !== null &&
    typeof http.request === 'function'
      ? createCapacitorHttpFetch(http)
      : undefined;
  return new Strybok({
    ...options,
    linkSource: options.linkSource ?? createCapacitorLinkSource(modules.App),
    platform,
    fetch: options.fetch ?? nativeFetch,
    sdkVersion: CAPACITOR_SDK_VERSION,
  });
}

function readPlatform(capacitor: CapacitorLike): unknown {
  try {
    return capacitor.getPlatform();
  } catch {
    return undefined;
  }
}
