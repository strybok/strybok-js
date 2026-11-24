// Minimal declarations of the two peer dependencies, limited to what this package imports, so it
// compiles without installing them. They are not part of the published typings: apps get the
// real `@capacitor/app` and `@capacitor/core` types from their own dependencies.

// An ambient module declaration cannot use a relative `import type`, hence import() types.
/* eslint-disable @typescript-eslint/consistent-type-imports */

declare module '@capacitor/app' {
  export const App: import('./link-source.js').CapacitorAppLike;
}

declare module '@capacitor/core' {
  export const Capacitor: import('./platform.js').CapacitorLike;
  /** Native HTTP plugin; exported by `@capacitor/core` since 4.1. */
  export const CapacitorHttp: import('./http.js').CapacitorHttpLike | undefined;
}
