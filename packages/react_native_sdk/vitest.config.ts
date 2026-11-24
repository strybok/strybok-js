import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The core is tested from source. `react-native` and `react` are peer dependencies that are
// deliberately not installed in this repository; tests replace them with small fakes.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@strybok\/js\/testing$/, replacement: at('../js_sdk/src/testing.ts') },
      { find: /^@strybok\/js$/, replacement: at('../js_sdk/src/index.ts') },
      { find: /^react-native$/, replacement: at('./test/fakes/react-native.ts') },
      { find: /^react$/, replacement: at('./test/fakes/react.ts') },
    ],
  },
});
