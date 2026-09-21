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

const typedPlatformTests = import.meta.glob('/src/platform/**/*.test.ts');
const legacyPlatformTests = import.meta.glob('/src/platform/**/*.test.js');

const moduleKey = (relativePath: string, extension: 'ts' | 'js'): string =>
  `/${relativePath}.${extension}`;

describe('Platform legacy test TypeScript cutover', () => {
  test.each(migrated)('%s stays TypeScript-only', (relativePath) => {
    expect(typedPlatformTests).toHaveProperty(moduleKey(relativePath, 'ts'));
    expect(legacyPlatformTests).not.toHaveProperty(moduleKey(relativePath, 'js'));
  });

  test('keeps the cutover scoped to Platform-owned tests', () => {
    expect(migrated).toHaveLength(11);
    expect(migrated.every((path) => path.startsWith('src/platform/'))).toBe(true);
  });

  test('module graph exposes every migrated test exactly once', () => {
    const migratedKeys = new Set(migrated.map((path) => moduleKey(path, 'ts')));
    expect(
      Object.keys(typedPlatformTests).filter((path) => migratedKeys.has(path)),
    ).toHaveLength(migrated.length);
  });
});
