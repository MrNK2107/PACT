import { defineConfig } from 'vite';

// The scenario acceptance suite (src/scenario/suite.scenarios.ts) is separate from `npm test`: it runs every
// scenario headless and takes a couple of minutes. `npm run scenarios` uses this config.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.scenarios.ts'], testTimeout: 300000, hookTimeout: 60000 },
});
