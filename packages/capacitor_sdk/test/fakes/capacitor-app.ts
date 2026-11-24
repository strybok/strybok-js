// Stands in for the `@capacitor/app` module in tests (see vitest.config.ts).
import type { CapacitorAppLike, ListenerHandleLike } from '../../src/link-source.js';

type UrlListener = (event: { url: string }) => void;

export class FakeApp implements CapacitorAppLike {
  launchUrl: string | undefined;
  /** Like the native plugin: a URL that arrived before the first listener is kept for it. */
  retained: string | undefined;
  readonly listeners = new Set<UrlListener>();
  readonly calls: string[] = [];

  getLaunchUrl(): Promise<{ url: string } | undefined> {
    this.calls.push('getLaunchUrl');
    return Promise.resolve(this.launchUrl === undefined ? undefined : { url: this.launchUrl });
  }

  addListener(eventName: 'appUrlOpen', listener: UrlListener): Promise<ListenerHandleLike> {
    this.calls.push(`addListener:${eventName}`);
    this.listeners.add(listener);
    const retained = this.retained;
    this.retained = undefined;
    if (retained !== undefined) queueMicrotask(() => listener({ url: retained }));
    return Promise.resolve({
      remove: () => {
        this.calls.push('remove');
        this.listeners.delete(listener);
        return Promise.resolve();
      },
    });
  }

  /** Simulates the OS handing `url` to the running app. */
  open(url: string): void {
    for (const listener of [...this.listeners]) listener({ url });
  }

  reset(): void {
    this.launchUrl = undefined;
    this.retained = undefined;
    this.listeners.clear();
    this.calls.length = 0;
  }
}

export const App = new FakeApp();
