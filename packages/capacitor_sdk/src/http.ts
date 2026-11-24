import type { FetchLike } from '@strybok/js';

/** The part of `CapacitorHttp` (from `@capacitor/core`) this SDK uses. */
export interface CapacitorHttpLike {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    data?: unknown;
    responseType?: 'text';
  }): Promise<{ status: number; data?: unknown }>;
}

/**
 * HTTP transport that sends requests through Capacitor's native HTTP plugin instead of the
 * WebView.
 *
 * A WebView `fetch` is a cross-origin browser request (the page lives on `capacitor://localhost`
 * or `https://localhost`) and is subject to CORS; native requests are not.
 */
export function createCapacitorHttpFetch(http: CapacitorHttpLike): FetchLike {
  return async (url, init) => {
    const contentType = init.headers['Content-Type'] ?? '';
    // The plugin serialises JSON bodies itself and expects the value, not a string.
    const data =
      init.body !== undefined && contentType.includes('application/json')
        ? (JSON.parse(init.body) as unknown)
        : init.body;
    const response = await http.request({
      url,
      method: init.method,
      headers: init.headers,
      ...(data !== undefined ? { data } : {}),
      responseType: 'text',
    });
    if (response === null || typeof response !== 'object' || typeof response.status !== 'number') {
      throw new TypeError('CapacitorHttp returned no response');
    }
    return {
      status: response.status,
      // The plugin already parses JSON responses; hand the core the text it expects.
      text: () => Promise.resolve(toText(response.data)),
    };
  };
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return '';
  return JSON.stringify(data);
}
