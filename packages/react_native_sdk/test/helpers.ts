import type { FetchRequestInit, FetchResponseLike } from '@strybok/js';

export const host = 'my-app.strybok.link';
export const apiBaseUrl = 'https://api.strybok.com';
export const invite = `https://${host}/invite777`;

export interface FakeApi {
  readonly resolves: string[];
  readonly events: Record<string, unknown>[];
  fetch(url: string, init: FetchRequestInit): Promise<FetchResponseLike>;
}

/** Answers every resolve call with route `/p/<slug>` and records `app_open` events. */
export function fakeApi(): FakeApi {
  const resolves: string[] = [];
  const events: Record<string, unknown>[] = [];
  return {
    resolves,
    events,
    fetch(url, init) {
      if (url.endsWith('/v1/public/events')) {
        events.push(JSON.parse(init.body ?? 'null') as Record<string, unknown>);
        return Promise.resolve({ status: 202, text: () => Promise.resolve('') });
      }
      resolves.push(url);
      const slug = decodeURIComponent(url).split('/').pop() as string;
      const body = JSON.stringify({
        linkId: `link_${slug}`,
        appId: 'app_1',
        routePath: `/p/${slug}`,
        payload: { slug },
      });
      return Promise.resolve({ status: 200, text: () => Promise.resolve(body) });
    },
  };
}

export function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
