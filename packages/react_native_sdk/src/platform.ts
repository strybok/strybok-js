import type { StrybokPlatform } from '@strybok/js';

/** The part of React Native's `Platform` module this SDK uses. */
export interface PlatformLike {
  readonly OS: string;
}

/** Maps `Platform.OS` to the platform reported with `app_open` events. */
export function toStrybokPlatform(os: unknown): StrybokPlatform {
  return os === 'ios' || os === 'android' ? os : 'unknown';
}
