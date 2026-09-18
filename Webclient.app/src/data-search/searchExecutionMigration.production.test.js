import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('legacy search core TypeScript migration ratchet', () => {
  it('keeps the execution runtime on strict TypeScript', () => {
    const sourceRoot = resolve(process.cwd(), 'src', 'Toolbox');
    expect(existsSync(resolve(sourceRoot, 'SearchExecutionRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'SearchExecutionRuntime.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'AddressSearchRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'AddressSearchRuntime.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'SearchCoordinatorRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'SearchCoordinatorRuntime.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'SearchDatasetRegistry.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'SearchDatasetRegistry.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'SearchSessionRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'SearchSessionRuntime.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'DataIntegrityHelper.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'DataIntegrityHelper.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'RecordPresentationRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'RecordPresentationRuntime.js'))).toBe(false);
    expect(existsSync(resolve(sourceRoot, 'SearchResultAdapterRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'SearchResultAdapterRuntime.js'))).toBe(false);
  });
});
