import { onTestFinished } from 'vitest';
import {
  Strybok,
  type FetchRequestInit,
  type FetchResponseLike,
  type StrybokError,
  type StrybokOptions,
} from '../src/index.js';
import { FakeLinkSource } from '../src/testing.js';

export const host = 'my-app.strybok.link';
export const apiBaseUrl = 'https://api.strybok.com';
export const invite = `https://${host}/invite777`;

export function response(status: number, body = ''): FetchResponseLike {
  return { status, text: () => Promise.resolve(body) };
}

export function ok({ route = '/invite/abc123', linkId = 'link_1' } = {}): FetchResponseLike {
  return response(
    200,
    JSON.stringify({
      linkId,
      appId: 'app_1',
      routePath: route,
      payload: { invitationId: 'abc123' },
    }),
  );
}

/** A promise that never settles: a server that does not answer. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export interface RecordedRequest {
  readonly url: string;
  readonly init: FetchRequestInit;
  /** Path of the request URL. */
  readonly path: string;
  /** Decoded query parameters of the request URL. */
  readonly query: Record<string, string>;
}

type Answer = FetchResponseLike | Promise<FetchResponseLike>;

/** Records requests and answers resolve calls with `onResolve`. */
export class Api {
  readonly resolves: RecordedRequest[] = [];
  readonly events: Record<string, unknown>[] = [];
  readonly eventRequests: RecordedRequest[] = [];
  onEvent: (() => Answer) | undefined;

  constructor(public onResolve?: (request: RecordedRequest) => Answer) {}

  readonly fetch = async (url: string, init: FetchRequestInit): Promise<FetchResponseLike> => {
    const request = record(url, init);
    if (request.path.endsWith('/v1/public/events')) {
      this.eventRequests.push(request);
      this.events.push(JSON.parse(init.body ?? 'null') as Record<string, unknown>);
      return (await this.onEvent?.()) ?? response(202);
    }
    this.resolves.push(request);
    return (await this.onResolve?.(request)) ?? ok();
  };
}

function record(url: string, init: FetchRequestInit): RecordedRequest {
  const parsed = new URL(url); // Node's URL is fine in tests; the SDK itself never uses it.
  return {
    url,
    init,
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
  };
}

export interface BridgeOptions extends Partial<StrybokOptions> {
  source?: FakeLinkSource;
  errors?: StrybokError[];
}

/** A Strybok wired to `api` with short timings; disposed when the test ends. */
export function bridge(api: Api, options: BridgeOptions = {}): Strybok {
  const { source, errors, ...rest } = options;
  const instance = new Strybok({
    apiBaseUrl,
    allowedHosts: [host],
    linkSource: source ?? new FakeLinkSource(),
    fetch: api.fetch,
    timeoutMs: 60,
    retryDelayMs: 1,
    onError: errors ? (error) => errors.push(error) : undefined,
    ...rest,
  });
  onTestFinished(() => instance.dispose());
  return instance;
}

export function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
