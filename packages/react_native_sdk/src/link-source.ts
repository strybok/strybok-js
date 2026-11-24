import type { LinkSource } from '@strybok/js';

/** The part of React Native's `Linking` module this SDK uses. */
export interface LinkingLike {
  getInitialURL(): Promise<string | null | undefined>;
  /** Returns a subscription since React Native 0.65; older versions return nothing. */
  addEventListener(
    type: 'url',
    handler: (event: { url: string }) => void,
  ): { remove(): void } | void;
  /** Only in React Native < 0.65. */
  removeEventListener?(type: 'url', handler: (event: { url: string }) => void): void;
}

/** A {@link LinkSource} backed by React Native's `Linking` (or anything shaped like it). */
export function createLinkingSource(linking: LinkingLike): LinkSource {
  return {
    getInitialUrl: () => linking.getInitialURL(),
    subscribe(listener) {
      const handler = (event: { url: string } | null | undefined): void => {
        const url = event?.url;
        if (typeof url === 'string') listener(url);
      };
      const subscription = linking.addEventListener('url', handler);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (subscription && typeof subscription.remove === 'function') subscription.remove();
        else linking.removeEventListener?.('url', handler);
      };
    },
  };
}
