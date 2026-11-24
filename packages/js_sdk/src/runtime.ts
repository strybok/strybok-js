import type { FetchLike } from './types.js';

/** Just enough of an `AbortController` to cancel a request. */
export interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

/**
 * The globals the SDK needs, typed structurally so that the sources compile without DOM or Node
 * typings. Timers exist in every runtime; the rest is optional and checked before use.
 */
interface Runtime {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  fetch?: FetchLike;
  AbortController?: new () => AbortControllerLike;
  crypto?: { getRandomValues?(array: Uint8Array): Uint8Array };
}

/** Read lazily, on every use, so that polyfills installed later (and test stubs) are seen. */
export function runtime(): Runtime {
  return globalThis as unknown as Runtime;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    runtime().setTimeout(resolve, ms);
  });
}
