import type { LinkSource } from './types.js';

export interface FakeLinkSourceOptions {
  /** URL reported as the one that launched the app. */
  initialUrl?: string | null;
  /** Mimics platforms that also report the launch URL to every new subscriber. */
  replayInitialUrlOnSubscribe?: boolean;
}

/** In-memory {@link LinkSource} to simulate incoming links in tests. */
export class FakeLinkSource implements LinkSource {
  /** URL reported as the one that launched the app. */
  initialUrl: string | null;

  /** Mimics platforms that also report the launch URL to every new subscriber. */
  readonly replayInitialUrlOnSubscribe: boolean;

  private readonly listeners = new Set<(url: string) => void>();

  constructor(options: FakeLinkSourceOptions = {}) {
    this.initialUrl = options.initialUrl ?? null;
    this.replayInitialUrlOnSubscribe = options.replayInitialUrlOnSubscribe ?? false;
  }

  /** Whether somebody is subscribed right now. */
  get hasListener(): boolean {
    return this.listeners.size > 0;
  }

  /** Simulates the OS delivering `url` to the running app. */
  emit(url: string): void {
    for (const listener of [...this.listeners]) listener(url);
  }

  getInitialUrl(): Promise<string | null> {
    return Promise.resolve(this.initialUrl);
  }

  subscribe(listener: (url: string) => void): () => void {
    // A wrapper per subscription, so the same function can subscribe twice independently.
    const entry = (url: string): void => listener(url);
    this.listeners.add(entry);
    const initial = this.initialUrl;
    if (this.replayInitialUrlOnSubscribe && initial !== null) {
      void Promise.resolve().then(() => {
        if (this.listeners.has(entry)) entry(initial);
      });
    }
    return () => {
      this.listeners.delete(entry);
    };
  }
}
