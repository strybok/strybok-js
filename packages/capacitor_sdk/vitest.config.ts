import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The core is tested from source. `@capacitor/app` and `@capacitor/core` are peer dependencies
// that are deliberately not installed in this repository; tests replace them with small fakes.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@strybok\/js\/testing$/, replacement: at('../js_sdk/src/testing.ts') },
      { find: /^@strybok\/js$/, replacement: at('../js_sdk/src/index.ts') },
      { find: /^@capacitor\/app$/, replacement: at('./test/fakes/capacitor-app.ts') },
      { find: /^@capacitor\/core$/, replacement: at('./test/fakes/capacitor-core.ts') },
    ],
  },
});
