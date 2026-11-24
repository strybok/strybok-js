// Stands in for the `@capacitor/core` module in tests (see vitest.config.ts).
import type { CapacitorHttpLike } from '../../src/http.js';

type HttpRequest = Parameters<CapacitorHttpLike['request']>[0];
type HttpResponse = Awaited<ReturnType<CapacitorHttpLike['request']>>;

export const state: {
  platform: string;
  requests: HttpRequest[];
  respond: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;
} = {
  platform: 'ios',
  requests: [],
  respond: () => ({ status: 500 }),
};

export const Capacitor = {
  getPlatform: (): string => state.platform,
};

export const CapacitorHttp: CapacitorHttpLike = {
  request: async (options) => {
    state.requests.push(options);
    return state.respond(options);
  },
};
