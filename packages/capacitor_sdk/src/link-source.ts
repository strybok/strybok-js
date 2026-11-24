import type { LinkSource } from '@strybok/js';

/** What `addListener` hands back; Capacitor 4 returned it directly, later versions in a promise. */
export interface ListenerHandleLike {
  remove(): Promise<void> | void;
}

/** The part of the `@capacitor/app` plugin this SDK uses. */
export interface CapacitorAppLike {
  getLaunchUrl(): Promise<{ url?: string } | null | undefined>;
  addListener(
    eventName: 'appUrlOpen',
    listener: (event: { url: string }) => void,
  ): Promise<ListenerHandleLike> | ListenerHandleLike;
}

/** A {@link LinkSource} backed by the `@capacitor/app` plugin (or anything shaped like it). */
export function createCapacitorLinkSource(app: CapacitorAppLike): LinkSource {
  return {
    async getInitialUrl() {
      const launch = await app.getLaunchUrl();
      const url = launch?.url;
      return typeof url === 'string' && url !== '' ? url : null;
    },
    subscribe(listener) {
      let active = true;
      // Registration is asynchronous, but the plugin keeps a URL that arrived before the first
      // listener and reports it once one is added.
      let handle: Promise<ListenerHandleLike | null>;
      try {
        handle = Promise.resolve(
          app.addListener('appUrlOpen', (event) => {
            const url = event?.url;
            if (active && typeof url === 'string') listener(url);
          }),
        ).catch(() => null); // Plugin not available: there is simply no stream.
      } catch {
        handle = Promise.resolve(null);
      }
      return () => {
        if (!active) return;
        active = false;
        void handle.then((registered) => registered?.remove()).catch(() => {});
      };
    },
  };
}
