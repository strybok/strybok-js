import type { StrybokPlatform } from '@strybok/js';

/** The part of the `Capacitor` global this SDK uses. */
export interface CapacitorLike {
  /** `'ios'`, `'android'` or `'web'`. */
  getPlatform(): string;
}

/** Maps `Capacitor.getPlatform()` to the platform reported with `app_open` events. */
export function toStrybokPlatform(platform: unknown): StrybokPlatform {
  return platform === 'ios' || platform === 'android' ? platform : 'unknown';
}
