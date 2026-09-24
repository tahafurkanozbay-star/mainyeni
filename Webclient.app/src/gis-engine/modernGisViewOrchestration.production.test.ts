import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (name: string): string => readFileSync(
  resolve(process.cwd(), 'src', 'gis-engine', name),
  'utf8',
);

const productionFiles = [
  'sceneSectionRuntime.ts',
  'modernGisViewOrchestrationRuntime.ts',
  'arcgisLayerViewLifecycleAdapter.ts',
  'arcgisViewTransitionAdapter.ts',
  'modernGisOrchestratedKernel.ts',
] as const;

const recoveredBoundedRuntimeFiles = [
  'layerResidencyRuntime.ts',
  'layerViewLifecycleCoordinator.ts',
  'layerVisibilityPolicy.ts',
  'sceneLodBudgetCoordinator.ts',
  'viewRenderStateCoordinator.ts',
  'viewStateTransitionCoordinator.ts',
  'arcgisLayerCapabilityPolicy.ts',
  'featureClusterBudgetCoordinator.ts',
  'spatialGeometryIntegrity.ts',
  'spatialOperationCoordinator.ts',
  'spatialQueryRequestCoordinator.ts',
] as const;

describe('modern GIS view orchestration production contracts', () => {
  it('does not introduce direct browser/network transports', () => {
    for (const file of productionFiles) {
      const content = source(file);
      expect(content, file).not.toMatch(/\bfetch\s*\(/);
      expect(content, file).not.toMatch(/\bXMLHttpRequest\b/);
      expect(content, file).not.toMatch(/\bWebSocket\b/);
      expect(content, file).not.toMatch(/\bEventSource\b/);
      expect(content, file).not.toMatch(/navigator\.sendBeacon/);
    }
  });

  it('does not add polling loops or hidden timers to orchestration policy', () => {
    for (const file of productionFiles) {
      const content = source(file);
      expect(content, file).not.toMatch(/\bsetInterval\s*\(/);
      expect(content, file).not.toMatch(/\bsetTimeout\s*\(/);
      expect(content, file).not.toMatch(/requestIdleCallback/);
    }
  });

  it('does not add forbidden WMS/WFS/WMTS service ownership', () => {
    for (const file of productionFiles) {
      const content = source(file);
      expect(content, file).not.toMatch(/\bWMS\b/i);
      expect(content, file).not.toMatch(/\bWFS\b/i);
      expect(content, file).not.toMatch(/\bWMTS\b/i);
    }
  });

  it('does not add remote endpoints or protocol-relative URLs', () => {
    for (const file of productionFiles) {
      const content = source(file);
      expect(content, file).not.toMatch(/https?:\/\//i);
      expect(content, file).not.toMatch(/['"]\/\//);
    }
  });

  it('does not use dynamic code execution primitives', () => {
    for (const file of productionFiles) {
      const content = source(file);
      expect(content, file).not.toMatch(/\beval\s*\(/);
      expect(content, file).not.toMatch(/\bnew\s+Function\s*\(/);
      expect(content, file).not.toMatch(/\bFunction\s*\(/);
    }
  });

  it('does not bypass the ArcGIS module transport with direct SDK imports', () => {
    for (const file of productionFiles) {
      const content = source(file);
      expect(content, file).not.toMatch(/from\s+['"]@arcgis\/core/);
      expect(content, file).not.toMatch(/import\s*\(\s*['"]@arcgis\/core/);
    }
  });

  it('keeps the orchestration runtime free of duplicate query and feature-integrity authorities', () => {
    const content = source('modernGisViewOrchestrationRuntime.ts');
    expect(content).not.toContain('spatialQueryRequestCoordinator');
    expect(content).not.toContain('spatialQueryControlPlane');
    expect(content).not.toContain('spatialOperationCoordinator');
    expect(content).not.toContain('spatialIntegrityRuntime');
    expect(content).not.toContain('adaptiveClusterRuntime');
    expect(content).not.toContain('featureClusterBudgetCoordinator');
    expect(content).not.toContain('layerResidencyRuntime');
    expect(content).not.toContain('viewRenderStateCoordinator');
    expect(content).not.toContain('layerVisibilityPolicy');
  });

  it('keeps the orchestrated kernel as composition rather than a second base kernel implementation', () => {
    const content = source('modernGisOrchestratedKernel.ts');
    expect(content).toContain("createModernGisKernel");
    expect(content).toContain("createModernGisViewOrchestrationRuntime");
    expect(content).not.toContain('createArcGisRequestScheduler');
    expect(content).not.toContain('createLayerLifecycleRuntime');
    expect(content).not.toContain('createSpatialQueryControlPlane');
    expect(content).not.toContain('createRenderGovernor');
  });

  it('requires explicit opt-in before an adapter destroys an ArcGIS-owned LayerView', () => {
    const content = source('arcgisLayerViewLifecycleAdapter.ts');
    expect(content).toContain('destroyLayerViewOnDispose === true');
    expect(content).toMatch(/layerView\.destroy\?\.\(\)/);
    expect(content).not.toMatch(/layerView\.destroy\?\.\(\)[\s\S]*destroyLayerViewOnDispose === true/);
  });

  it('passes transition cancellation through a caller-owned AbortSignal', () => {
    const content = source('arcgisViewTransitionAdapter.ts');
    expect(content).toContain('signal: context.signal');
    expect(content).toMatch(/context\.signal\.aborted/);
    expect(content).toContain("name = 'AbortError'");
  });

  it('keeps Scene section state bounded by explicit section, plane and layer limits', () => {
    const content = source('sceneSectionRuntime.ts');
    expect(content).toContain('DEFAULT_MAX_SECTIONS');
    expect(content).toContain('DEFAULT_MAX_PLANES_PER_SECTION');
    expect(content).toContain('DEFAULT_MAX_ACTIVE_PLANES');
    expect(content).toContain('DEFAULT_MAX_TARGET_LAYERS');
    expect(content).toContain('coordinateMagnitude');
  });

  it('enrolls recovered and new GIS modules in the strict modern-core TypeScript boundary', () => {
    const config = JSON.parse(readFileSync(
      resolve(process.cwd(), 'tsconfig.gis-modern-core.json'),
      'utf8',
    )) as { files?: string[] };
    const files = new Set(config.files ?? []);
    for (const file of recoveredBoundedRuntimeFiles) {
      expect(files.has(`src/gis-engine/${file}`), file).toBe(true);
    }
    for (const file of productionFiles) {
      expect(files.has(`src/gis-engine/${file}`), file).toBe(true);
    }
  });

  it('enrolls the focused orchestration regressions in the same compiler boundary', () => {
    const config = JSON.parse(readFileSync(
      resolve(process.cwd(), 'tsconfig.gis-modern-core.json'),
      'utf8',
    )) as { files?: string[] };
    const files = new Set(config.files ?? []);
    for (const file of [
      'sceneSectionRuntime.test.ts',
      'modernGisViewOrchestrationRuntime.test.ts',
      'arcgisLayerViewLifecycleAdapter.test.ts',
      'arcgisViewTransitionAdapter.test.ts',
      'modernGisOrchestratedKernel.test.ts',
    ]) {
      expect(files.has(`src/gis-engine/${file}`), file).toBe(true);
    }
  });
});
