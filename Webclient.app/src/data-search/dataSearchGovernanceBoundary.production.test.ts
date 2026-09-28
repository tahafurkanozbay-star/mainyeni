import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GOVERNANCE_MODULES = Object.freeze([
  'categoryOntologyRuntime.ts',
  'filterIndexRuntime.ts',
  'schemaRegistryRuntime.ts',
  'revisionedSearchCache.ts',
  'spatialCursorRuntime.ts',
  'dataSearchGovernanceRuntime.ts',
]);

const readModule = (name: string): string => readFileSync(
  resolve(process.cwd(), 'src', 'data-search', name),
  'utf8',
);

describe('Data/Search v5 governance production boundary', () => {
  it('keeps every v5 production module inside strict TypeScript', () => {
    for (const moduleName of GOVERNANCE_MODULES) {
      expect(moduleName.endsWith('.ts')).toBe(true);
      expect(moduleName.endsWith('.js')).toBe(false);
      expect(readModule(moduleName).length).toBeGreaterThan(100);
    }
  });

  it('does not introduce browser network transports or external endpoints', () => {
    for (const moduleName of GOVERNANCE_MODULES) {
      const source = readModule(moduleName);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/\bXMLHttpRequest\b/);
      expect(source).not.toMatch(/\bWebSocket\b/);
      expect(source).not.toMatch(/\baxios\b/);
      expect(source).not.toMatch(/https?:\/\//i);
    }
  });

  it('does not add WMS, WFS or WMTS integration', () => {
    for (const moduleName of GOVERNANCE_MODULES) {
      const source = readModule(moduleName);
      expect(source).not.toMatch(/\bWMS\b/);
      expect(source).not.toMatch(/\bWFS\b/);
      expect(source).not.toMatch(/\bWMTS\b/);
    }
  });

  it('does not create a second icon registry or load icon assets', () => {
    for (const moduleName of GOVERNANCE_MODULES) {
      const source = readModule(moduleName);
      expect(source).not.toMatch(/iconRegistry\.json/);
      expect(source).not.toMatch(/images\/icons\//);
      expect(source).not.toMatch(/createPictureMarkerSymbol/);
      expect(source).not.toMatch(/resolveRecordIcon/);
    }
  });

  it('keeps category icon data as hints instead of presentation authority', () => {
    const source = readModule('categoryOntologyRuntime.ts');
    expect(source).toContain('iconHint');
    expect(source).not.toContain('iconUrl');
    expect(source).not.toContain('marker2d');
    expect(source).not.toContain('graphic3d');
  });

  it('binds cache identity to revision and dataset fingerprint', () => {
    const source = readModule('revisionedSearchCache.ts');
    expect(source).toContain('revision: dataset.revision');
    expect(source).toContain('datasetFingerprint: dataset.fingerprint');
    expect(source).toContain('requestFingerprint');
    expect(source).toContain('windowFingerprint');
  });

  it('binds spatial cursors to revision, fingerprint and query identity', () => {
    const source = readModule('spatialCursorRuntime.ts');
    expect(source).toContain('SPATIAL_CURSOR_REVISION_MISMATCH');
    expect(source).toContain('SPATIAL_CURSOR_FINGERPRINT_MISMATCH');
    expect(source).toContain('SPATIAL_CURSOR_QUERY_MISMATCH');
    expect(source).toContain('recordFingerprint');
  });

  it('keeps schema admission explicit and fail-closed in strict mode', () => {
    const source = readModule('schemaRegistryRuntime.ts');
    expect(source).toContain("SchemaRegistryMode = 'strict' | 'warning' | 'observe'");
    expect(source).toContain("decision: 'rejected'");
    expect(source).toContain('breaking-schema-drift');
    expect(source).toContain('revision-conflict');
  });

  it('keeps filter planning bounded by candidate and posting budgets', () => {
    const source = readModule('filterIndexRuntime.ts');
    expect(source).toContain('maxPostingsPerValue');
    expect(source).toContain('maxCandidatePositions');
    expect(source).toContain('maxDistinctValuesPerField');
  });

  it('exports the composed v5 surface from the canonical Data/Search barrel', () => {
    const index = readModule('index.ts');
    expect(index).toContain("export * from './categoryOntologyRuntime';");
    expect(index).toContain("export * from './filterIndexRuntime';");
    expect(index).toContain("export * from './schemaRegistryRuntime';");
    expect(index).toContain("export * from './revisionedSearchCache';");
    expect(index).toContain("export * from './spatialCursorRuntime';");
    expect(index).toContain("export * from './dataSearchGovernanceRuntime';");
  });
});
