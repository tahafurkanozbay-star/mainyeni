import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const migrated = Object.freeze([
  'src/platform/bootstrap/bootstrapCore.test',
  'src/platform/bootstrap/bootstrapDiagnostics.test',
  'src/platform/http/fetchTransport.test',
  'src/platform/http/networkDiagnostics.test',
  'src/platform/http/requestScheduler.test',
  'src/platform/http/retryPolicy.test',
  'src/platform/http/runtimeCapabilities.test',
  'src/platform/http/typescriptRuntime.integration.test',
  'src/platform/performance/performanceMonitor.test',
  'src/platform/runtime/runtime.test',
  'src/platform/runtime/runtimeDiagnostics.test',
]);

describe('Platform legacy test TypeScript cutover', () => {
  test.each(migrated)('%s stays TypeScript-only', (relativePath) => {
    const root = process.cwd();
    expect(existsSync(resolve(root, `${relativePath}.ts`))).toBe(true);
    expect(existsSync(resolve(root, `${relativePath}.js`))).toBe(false);
  });

  test('keeps the cutover scoped to Platform-owned tests', () => {
    expect(migrated).toHaveLength(11);
    expect(migrated.every((path) => path.startsWith('src/platform/'))).toBe(true);
  });
});
