import { defineConfig } from 'vitest/config'

// The GIS policy modules are source-only and live outside Webclient.app.
// Keep their tests independently runnable instead of treating unrelated
// Webclient.app Release QA success as evidence for this source tree.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/lib/gis/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    pool: 'threads',
    maxWorkers: 2,
    fileParallelism: false,
    isolate: true,
    testTimeout: 10_000,
  },
})
