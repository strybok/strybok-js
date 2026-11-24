// Minimal declarations of the two peer dependencies, limited to what this package imports, so it
// compiles without installing them. They are not part of the published typings: apps get the
// real `react` and `react-native` types from their own dependencies.

// An ambient module declaration cannot use a relative `import type`, hence import() types.
/* eslint-disable @typescript-eslint/consistent-type-imports */

declare module 'react-native' {
  export const Linking: import('./link-source.js').LinkingLike;
  export const Platform: import('./platform.js').PlatformLike;
}

declare module 'react' {
  export const useEffect: import('./hook.js').HooksLike['useEffect'];
  export const useRef: import('./hook.js').HooksLike['useRef'];
}
