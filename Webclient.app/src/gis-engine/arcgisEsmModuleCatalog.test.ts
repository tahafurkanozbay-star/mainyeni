import { describe, expect, it } from 'vitest';
import {
  auditArcgisModuleCatalog,
  describeArcgisModuleCatalog,
  getArcgisModuleDescriptor,
  listArcgisModulesByGroup,
  requireArcgisModuleDescriptor,
  resolveArcgisCatalogModules,
  sumArcgisModuleRelativeWeight,
} from './arcgisEsmModuleCatalog';
import { getDefaultArcgisEsmSpecifiers } from './arcgisEsmTransport';

describe('arcgisEsmModuleCatalog', () => {
  it('covers every statically registered production ESM importer exactly', () => {
    const audit = auditArcgisModuleCatalog(getDefaultArcgisEsmSpecifiers());
    expect(audit.valid).toBe(true);
    expect(audit.missingFromCatalog).toEqual([]);
    expect(audit.missingFromTransport).toEqual([]);
    expect(audit.catalogSpecifiers).toEqual(audit.registeredSpecifiers);
  });

  it('maps legacy compatibility ids onto the modern ESM descriptor', () => {
    const watchUtils = requireArcgisModuleDescriptor('esri/core/watchUtils');
    const reactiveUtils = requireArcgisModuleDescriptor('esri/core/reactiveUtils');
    expect(watchUtils).toBe(reactiveUtils);
    expect(watchUtils.specifier).toBe('@arcgis/core/core/reactiveUtils.js');

    const queryTask = requireArcgisModuleDescriptor('esri/tasks/QueryTask');
    const modernQuery = requireArcgisModuleDescriptor('esri/rest/query');
    expect(queryTask).toBe(modernQuery);
    expect(queryTask.specifier).toBe('@arcgis/core/rest/query.js');
  });

  it('deduplicates requested ids by their ESM specifier while preserving first-request semantics', () => {
    const resolved = resolveArcgisCatalogModules([
      'esri/tasks/QueryTask',
      'esri/rest/query',
      'esri/Map',
      '@arcgis/core/Map.js',
    ]);
    expect(resolved.map((item) => item.requestedId)).toEqual([
      'esri/tasks/QueryTask',
      'esri/Map',
    ]);
    expect(resolved.map((item) => item.descriptor.specifier)).toEqual([
      '@arcgis/core/rest/query.js',
      '@arcgis/core/Map.js',
    ]);
  });

  it('exposes deterministic group and weight metadata for planning', () => {
    const sceneModules = listArcgisModulesByGroup('view-3d');
    expect(sceneModules.map((item) => item.moduleId)).toContain('esri/views/SceneView');
    expect(sceneModules.map((item) => item.moduleId)).toContain('esri/layers/SceneLayer');
    expect(sumArcgisModuleRelativeWeight(['esri/Map', 'esri/views/MapView'])).toBe(10);

    const summary = describeArcgisModuleCatalog();
    expect(summary.moduleCount).toBe(getDefaultArcgisEsmSpecifiers().length);
    expect(summary.groups.layer).toBeGreaterThan(5);
    expect(summary.prewarm['on-demand']).toBeGreaterThan(5);
    expect(summary.relativeWeight).toBeGreaterThan(summary.moduleCount);
  });

  it('fails closed for unsupported or empty module identifiers', () => {
    expect(getArcgisModuleDescriptor('esri/Map')?.specifier).toBe('@arcgis/core/Map.js');
    expect(() => getArcgisModuleDescriptor('dojo/Deferred')).toThrow(/Unsupported ArcGIS module id/);
    expect(() => requireArcgisModuleDescriptor('   ')).toThrow(/required/);
  });

  it('reports drift in either direction without mutating the catalog', () => {
    const registered = getDefaultArcgisEsmSpecifiers();
    const missingOne = registered.slice(1);
    const auditMissing = auditArcgisModuleCatalog(missingOne);
    expect(auditMissing.valid).toBe(false);
    expect(auditMissing.missingFromTransport).toContain(registered[0]);

    const auditExtra = auditArcgisModuleCatalog([...registered, '@arcgis/core/fake.js']);
    expect(auditExtra.valid).toBe(false);
    expect(auditExtra.missingFromCatalog).toEqual(['@arcgis/core/fake.js']);
  });
});
