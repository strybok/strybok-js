import { SDK_VERSION, Strybok, type StrybokOptions } from '@strybok/js';
import { createLinkingSource, type LinkingLike } from './link-source.js';
import { toStrybokPlatform, type PlatformLike } from './platform.js';

/** Sent with `app_open` events: the core version plus the adapter name. */
export const REACT_NATIVE_SDK_VERSION = `${SDK_VERSION}+react-native`;

/**
 * Options of {@link Strybok}, with the React Native parts filled in: `linkSource` defaults to
 * `Linking`, `platform` to `Platform.OS`. Both can still be overridden (tests do).
 */
export type ReactNativeStrybokOptions = Omit<
  StrybokOptions,
  'linkSource' | 'platform' | 'sdkVersion'
> &
  Partial<Pick<StrybokOptions, 'linkSource' | 'platform'>>;

export interface ReactNativeModules {
  readonly Linking: LinkingLike;
  readonly Platform: PlatformLike;
}

/** {@link createStrybok} with the React Native modules passed in. */
export function createStrybokWith(
  modules: ReactNativeModules,
  options: ReactNativeStrybokOptions,
): Strybok {
  return new Strybok({
    ...options,
    linkSource: options.linkSource ?? createLinkingSource(modules.Linking),
    platform: options.platform ?? toStrybokPlatform(modules.Platform.OS),
    sdkVersion: REACT_NATIVE_SDK_VERSION,
  });
}
