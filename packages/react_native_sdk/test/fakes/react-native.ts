// Stands in for the `react-native` module in tests (see vitest.config.ts).
import type { LinkingLike } from '../../src/link-source.js';

type UrlHandler = (event: { url: string }) => void;

export class FakeLinking implements LinkingLike {
  initialUrl: string | null = null;
  readonly handlers = new Set<UrlHandler>();
  readonly calls: string[] = [];

  getInitialURL(): Promise<string | null> {
    this.calls.push('getInitialURL');
    return Promise.resolve(this.initialUrl);
  }

  addEventListener(type: 'url', handler: UrlHandler): { remove(): void } {
    this.calls.push(`addEventListener:${type}`);
    this.handlers.add(handler);
    return {
      remove: () => {
        this.calls.push('remove');
        this.handlers.delete(handler);
      },
    };
  }

  /** Simulates the OS handing `url` to the running app. */
  open(url: string): void {
    for (const handler of [...this.handlers]) handler({ url });
  }

  reset(): void {
    this.initialUrl = null;
    this.handlers.clear();
    this.calls.length = 0;
  }
}

export const Linking = new FakeLinking();
export const Platform: { OS: string } = { OS: 'ios' };
