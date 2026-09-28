import { describe, expect, it } from 'vitest';
import { ArcGisClusterBudgetPlanner } from './ArcGisClusterBudgetPlanner';
import { ArcGisFeatureSchemaRegistry, type ArcGisFeatureSchemaSnapshot } from './ArcGisFeatureSchemaRegistry';
import { ArcGisLayerWorksetPlanner } from './ArcGisLayerWorksetPlanner';
import { ArcGisRendererBudgetPlanner } from './ArcGisRendererBudgetPlanner';
import { ArcGisServiceCapabilityRegistry, type ArcGisServiceCapabilitySnapshot } from './ArcGisServiceCapabilityRegistry';
import { ArcGisSpatialReferenceCompatibilityPlanner } from './ArcGisSpatialReferenceCompatibilityPlanner';

const servicePolicy = {
  maxServices: 8,
  maxServiceKeyLength: 80,
  maxRevisionLength: 40,
  maxCapabilities: 14,
  maxQueryFormats: 3,
  maxLayerIds: 32,
  maxTableIds: 16,
  maxRecordCount: 20_000,
  retentionMs: 60_000,
  maxClockSkewMs: 100,
} as const;

const schemaPolicy = {
  maxLayers: 16,
  maxFieldsPerLayer: 32,
  maxSubtypesPerLayer: 8,
  maxSubtypeDomains: 8,
  maxCodedValues: 32,
  maxServiceKeyLength: 80,
  maxRevisionLength: 40,
  maxFieldNameLength: 64,
  maxAliasLength: 100,
  maxDomainNameLength: 100,
  maxDomainValueLength: 100,
  maxStringFieldLength: 1_024,
  retentionMs: 60_000,
  maxClockSkewMs: 100,
} as const;

const rendererPolicy = {
  maxLayerKeyLength: 80,
  maxFeatures2d: 8_000,
  maxFeatures3d: 3_000,
  maxUniqueValues: 64,
  maxClassBreaks: 20,
  maxSymbols: 80,
  maxSymbolLayers: 160,
  maxLabelClasses: 8,
  maxVisualVariables: 4,
  maxColorOpacityStops: 8,
  maxSizeStops: 6,
  maxRotationStops: 4,
  maxGpuBytesPerFrame: 48_000_000,
  maxCpuMsPerFrame: 12,
  maxDrawCallsPerFrame: 180,
  maxComplexityUnits: 1_000,
  clusterRecommendationThreshold: 4_000,
  threeDimensionalCostPercent: 150,
} as const;

const clusterPolicy = {
  maxLayerKeyLength: 80,
  directFeatureThreshold2d: 2_000,
  directFeatureThreshold3d: 1_000,
  minClusterRadiusPx: 20,
  maxClusterRadiusPx: 160,
  minClusterSymbolSizePx: 8,
  maxClusterSymbolSizePx: 96,
  maxAggregateFields: 12,
  maxLabelClasses: 4,
  maxPopupFields: 16,
  maxEstimatedClusters: 500,
  maxClusterMemoryBytes: 2_000_000,
  estimatedBytesPerCluster: 2_000,
  maxViewportPixelArea: 20_000_000,
} as const;

const worksetPolicy = {
  maxCandidates: 16,
  maxLayerKeyLength: 80,
  maxActiveLayers2d: 5,
  maxActiveLayers3d: 3,
  maxFeatures2d: 12_000,
  maxFeatures3d: 5_000,
  maxCpuMs2d: 12,
  maxCpuMs3d: 8,
  maxGpuBytes2d: 64_000_000,
  maxGpuBytes3d: 48_000_000,
  maxDrawCalls2d: 220,
  maxDrawCalls3d: 140,
} as const;

const capability = (overrides: Partial<ArcGisServiceCapabilitySnapshot> = {}): ArcGisServiceCapabilitySnapshot => ({
  serviceKey: 'verified-feature-service',
  serviceKind: 'feature',
  revision: 'service-r1',
  observedAtMs: 100,
  currentVersion: 11.5,
  maxRecordCount: 2_000,
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  capabilities: ['editing', 'order-by', 'pagination', 'query', 'statistics', 'sync', 'time'],
  queryFormats: ['geojson', 'json', 'pbf'],
  layerIds: [0, 1],
  tableIds: [10],
  supportsPagination: true,
  supportsOrderBy: true,
  supportsStatistics: true,
  supportsEditing: true,
  supportsSync: true,
  timeAware: true,
  ...overrides,
});

const featureSchema = (overrides: Partial<ArcGisFeatureSchemaSnapshot> = {}): ArcGisFeatureSchemaSnapshot => ({
  serviceKey: 'verified-feature-service',
  layerId: 0,
  revision: 'layer-r1',
  observedAtMs: 100,
  objectIdField: 'OBJECTID',
  globalIdField: 'GlobalID',
  typeIdField: 'TYPE_ID',
  fields: [
    { name: 'OBJECTID', alias: 'Object ID', type: 'esriFieldTypeOID', length: null, editable: false, nullable: false, domain: null },
    { name: 'GlobalID', alias: 'Global ID', type: 'esriFieldTypeGlobalID', length: 38, editable: false, nullable: false, domain: null },
    { name: 'TYPE_ID', alias: 'Type', type: 'esriFieldTypeInteger', length: null, editable: true, nullable: false, domain: null },
    { name: 'CATEGORY', alias: 'Category', type: 'esriFieldTypeString', length: 50, editable: true, nullable: true, domain: { type: 'codedValue', name: 'Category domain', codedValues: [{ name: 'A', code: 'A' }, { name: 'B', code: 'B' }] } },
    { name: 'VALUE', alias: 'Value', type: 'esriFieldTypeDouble', length: null, editable: true, nullable: true, domain: { type: 'range', name: 'Value range', min: 0, max: 10_000 } },
  ],
  subtypes: [
    { id: 1, name: 'Primary', domains: [{ fieldName: 'CATEGORY', domain: { type: 'inherited' } }] },
  ],
  ...overrides,
});

describe('ArcGIS runtime governance integration', () => {
  it('admits a verified service/layer through capability, schema, renderer and workset gates', () => {
    const services = new ArcGisServiceCapabilityRegistry(servicePolicy);
    const schemas = new ArcGisFeatureSchemaRegistry(schemaPolicy);
    expect(services.observe(capability()).compatible).toBe(true);
    expect(schemas.observe(featureSchema()).compatible).toBe(true);

    const spatial = new ArcGisSpatialReferenceCompatibilityPlanner({ maxWkid: 1_000_000_000, requireVerticalReferenceForZ: false }).plan({
      source: { wkid: 102100, latestWkid: 3857, vcsWkid: null, latestVcsWkid: null },
      target: { wkid: 3857, latestWkid: 3857, vcsWkid: null, latestVcsWkid: null },
      hasZ: false,
      hasM: false,
      horizontalProjectionAvailable: false,
      verticalTransformationAvailable: false,
    });
    expect(spatial.mode).toBe('alias');

    const renderer = new ArcGisRendererBudgetPlanner(rendererPolicy).plan({
      layerKey: 'verified-feature-service:0',
      viewMode: '2d',
      geometryType: 'point',
      rendererType: 'unique-value',
      featureCountEstimate: 1_500,
      uniqueValueCount: 2,
      classBreakCount: 0,
      symbolCount: 3,
      symbolLayerCount: 4,
      labelClassCount: 1,
      visualVariables: [{ type: 'size', stopCount: 4 }],
      gpuBytesPerFeature: 2_000,
      cpuMicrosPerFeature: 3,
      expectedDrawCalls: 30,
      clusterEnabled: false,
    });
    expect(renderer.qualityTier).toBe('full');

    const workset = new ArcGisLayerWorksetPlanner(worksetPolicy).plan('2d', 50_000, [{
      layerKey: 'verified-feature-service:0',
      priority: 'visible',
      health: 'available',
      requestedVisible: true,
      minScale: 0,
      maxScale: 0,
      featureCountEstimate: renderer.admittedFeatureCount,
      cpuMsEstimate: renderer.estimatedCpuMs,
      gpuBytesEstimate: renderer.estimatedGpuBytes,
      drawCallsEstimate: renderer.expectedDrawCalls,
    }]);
    expect(workset.admittedLayerKeys).toEqual(['verified-feature-service:0']);
  });

  it('turns service capability shrink into an explicit compatibility failure before query/runtime use', () => {
    const services = new ArcGisServiceCapabilityRegistry(servicePolicy);
    services.observe(capability());
    const shrink = services.observe(capability({
      revision: 'service-r2',
      observedAtMs: 200,
      maxRecordCount: 500,
      capabilities: ['query'],
      queryFormats: ['json'],
      supportsPagination: false,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
      timeAware: false,
    }));
    expect(shrink.compatible).toBe(false);
    expect(shrink.breakingChanges).toEqual(expect.arrayContaining([
      'max-record-count-decreased',
      'pagination-disabled',
      'editing-disabled',
      'sync-disabled',
    ]));
  });

  it('turns field removal and domain drift into explicit schema compatibility failures', () => {
    const schemas = new ArcGisFeatureSchemaRegistry(schemaPolicy);
    schemas.observe(featureSchema());
    const nextFields = featureSchema().fields
      .filter((field) => field.name !== 'VALUE')
      .map((field) => field.name === 'CATEGORY' ? { ...field, domain: { type: 'codedValue' as const, name: 'Category domain', codedValues: [{ name: 'A', code: 'A' }] } } : field);
    const drift = schemas.observe(featureSchema({ revision: 'layer-r2', observedAtMs: 200, fields: nextFields }));
    expect(drift.compatible).toBe(false);
    expect(drift.breakingChanges).toEqual(expect.arrayContaining(['field-removed:VALUE', 'domain-changed:CATEGORY']));
  });

  it('fails closed when a verified service identity is rebound to a different spatial reference', () => {
    const services = new ArcGisServiceCapabilityRegistry(servicePolicy);
    services.observe(capability());
    expect(() => services.observe(capability({
      revision: 'service-r2',
      observedAtMs: 200,
      spatialReference: { wkid: 4326, latestWkid: null },
    }))).toThrow('identity rebind requires explicit approval');
  });

  it('requires explicit horizontal projection availability when view and service WKIDs differ', () => {
    const planner = new ArcGisSpatialReferenceCompatibilityPlanner({ maxWkid: 1_000_000_000, requireVerticalReferenceForZ: false });
    const rejected = planner.plan({
      source: { wkid: 3857, latestWkid: null, vcsWkid: null, latestVcsWkid: null },
      target: { wkid: 4326, latestWkid: null, vcsWkid: null, latestVcsWkid: null },
      hasZ: false,
      hasM: false,
      horizontalProjectionAvailable: false,
      verticalTransformationAvailable: false,
    });
    expect(rejected.mode).toBe('reject');
    const admitted = planner.plan({
      source: rejected.source,
      target: rejected.target,
      hasZ: false,
      hasM: false,
      horizontalProjectionAvailable: true,
      verticalTransformationAvailable: false,
    });
    expect(admitted.mode).toBe('project');
  });

  it('uses clustering to turn a dense feature estimate into a bounded render workset', () => {
    const cluster = new ArcGisClusterBudgetPlanner(clusterPolicy).plan({
      layerKey: 'verified-feature-service:0',
      viewMode: '2d',
      geometryType: 'point',
      featureCountEstimate: 50_000,
      viewportPixelArea: 2_000_000,
      requestedRadiusPx: 60,
      clusterMinSizePx: 16,
      clusterMaxSizePx: 48,
      aggregateFieldCount: 3,
      labelClassCount: 1,
      popupFieldCount: 5,
      viewScale: 100_000,
      clusterMaxScale: 50_000,
      clusteringSupported: true,
    });
    expect(cluster.mode).toBe('cluster');
    expect(cluster.estimatedClusterCount).toBeLessThan(500);

    const renderer = new ArcGisRendererBudgetPlanner(rendererPolicy).plan({
      layerKey: 'verified-feature-service:0:clusters',
      viewMode: '2d',
      geometryType: 'point',
      rendererType: 'simple',
      featureCountEstimate: cluster.estimatedClusterCount,
      uniqueValueCount: 0,
      classBreakCount: 0,
      symbolCount: 1,
      symbolLayerCount: 2,
      labelClassCount: 1,
      visualVariables: [{ type: 'size', stopCount: 4 }],
      gpuBytesPerFeature: 3_000,
      cpuMicrosPerFeature: 5,
      expectedDrawCalls: 20,
      clusterEnabled: true,
    });
    expect(renderer.qualityTier).toBe('full');

    const workset = new ArcGisLayerWorksetPlanner(worksetPolicy).plan('2d', 100_000, [{
      layerKey: 'verified-feature-service:0',
      priority: 'visible',
      health: 'available',
      requestedVisible: true,
      minScale: 0,
      maxScale: 0,
      featureCountEstimate: renderer.admittedFeatureCount,
      cpuMsEstimate: renderer.estimatedCpuMs,
      gpuBytesEstimate: renderer.estimatedGpuBytes,
      drawCallsEstimate: renderer.expectedDrawCalls,
    }]);
    expect(workset.admittedLayerKeys).toEqual(['verified-feature-service:0']);
  });

  it('fails dense rendering when clustering is scale-disabled and direct feature budget cannot absorb it', () => {
    const cluster = new ArcGisClusterBudgetPlanner(clusterPolicy).plan({
      layerKey: 'verified-feature-service:0',
      viewMode: '2d',
      geometryType: 'point',
      featureCountEstimate: 50_000,
      viewportPixelArea: 2_000_000,
      requestedRadiusPx: 60,
      clusterMinSizePx: 16,
      clusterMaxSizePx: 48,
      aggregateFieldCount: 3,
      labelClassCount: 1,
      popupFieldCount: 5,
      viewScale: 10_000,
      clusterMaxScale: 50_000,
      clusteringSupported: true,
    });
    expect(cluster.mode).toBe('reject');
    expect(cluster.reasons).toEqual(expect.arrayContaining(['scale-disables-clustering', 'direct-feature-budget']));
  });

  it('keeps unavailable service health outside the active render workset', () => {
    const workset = new ArcGisLayerWorksetPlanner(worksetPolicy).plan('2d', 50_000, [
      {
        layerKey: 'offline-layer', priority: 'critical', health: 'unavailable', requestedVisible: true,
        minScale: 0, maxScale: 0, featureCountEstimate: 100, cpuMsEstimate: 1, gpuBytesEstimate: 1_000_000, drawCallsEstimate: 5,
      },
      {
        layerKey: 'healthy-layer', priority: 'visible', health: 'available', requestedVisible: true,
        minScale: 0, maxScale: 0, featureCountEstimate: 100, cpuMsEstimate: 1, gpuBytesEstimate: 1_000_000, drawCallsEstimate: 5,
      },
    ]);
    expect(workset.admittedLayerKeys).toEqual(['healthy-layer']);
    expect(workset.rejected).toContainEqual({ layerKey: 'offline-layer', reason: 'unavailable' });
  });

  it('keeps capability and schema snapshot restore atomic under duplicate identities', () => {
    const services = new ArcGisServiceCapabilityRegistry(servicePolicy);
    services.observe(capability());
    const serviceSnapshot = services.snapshot(100);
    const serviceEntry = serviceSnapshot.entries[0]!;
    expect(() => services.restore({ entries: [serviceEntry, serviceEntry] }, 100)).toThrow('duplicate service metadata entry');
    expect(services.snapshot(100).entries).toEqual(serviceSnapshot.entries);

    const schemas = new ArcGisFeatureSchemaRegistry(schemaPolicy);
    schemas.observe(featureSchema());
    const schemaSnapshot = schemas.snapshot(100);
    const schemaEntry = schemaSnapshot.entries[0]!;
    expect(() => schemas.restore({ entries: [schemaEntry, schemaEntry] }, 100)).toThrow('duplicate feature schema entry');
    expect(schemas.snapshot(100).entries).toEqual(schemaSnapshot.entries);
  });

  it('does not mutate caller-owned metadata arrays across the governance boundary', () => {
    const layerIds = [0, 1];
    const capabilities = ['query', 'pagination'] as const;
    const services = new ArcGisServiceCapabilityRegistry(servicePolicy);
    services.observe(capability({
      layerIds,
      capabilities,
      queryFormats: ['json'],
      supportsPagination: true,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
      timeAware: false,
    }));
    layerIds.push(99);
    expect(services.get('verified-feature-service', 100)?.metadata.layerIds).toEqual([0, 1]);
  });

  it('produces deterministic decisions for repeated equivalent renderer and workset inputs', () => {
    const renderInput = {
      layerKey: 'stable', viewMode: '2d' as const, geometryType: 'polygon' as const, rendererType: 'class-breaks' as const,
      featureCountEstimate: 3_000, uniqueValueCount: 0, classBreakCount: 5, symbolCount: 6, symbolLayerCount: 8,
      labelClassCount: 1, visualVariables: [{ type: 'color' as const, stopCount: 5 }], gpuBytesPerFeature: 2_000,
      cpuMicrosPerFeature: 2, expectedDrawCalls: 25, clusterEnabled: false,
    };
    const renderer = new ArcGisRendererBudgetPlanner(rendererPolicy);
    expect(renderer.plan(renderInput)).toEqual(renderer.plan(renderInput));

    const workset = new ArcGisLayerWorksetPlanner(worksetPolicy);
    const candidates = [{
      layerKey: 'stable', priority: 'visible' as const, health: 'available' as const, requestedVisible: true,
      minScale: 0, maxScale: 0, featureCountEstimate: 3_000, cpuMsEstimate: 6, gpuBytesEstimate: 6_000_000, drawCallsEstimate: 25,
    }];
    expect(workset.plan('2d', 50_000, candidates)).toEqual(workset.plan('2d', 50_000, candidates));
  });
});
