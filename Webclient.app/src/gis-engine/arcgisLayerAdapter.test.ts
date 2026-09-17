import { describe, expect, it } from 'vitest';
import { adaptArcGisLayerMetadata } from './arcgisMetadataAdapter';
import { adaptArcGisLayer, adaptArcGisLayers, ArcGisLayerAdapterError, isLayerVisibleAtScale } from './arcgisLayerAdapter';

const metadata = (url = 'https://example.test/arcgis/rest/services/Parcels/FeatureServer/0') => adaptArcGisLayerMetadata({
  id: 0,
  name: 'Parcels',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPolygon',
  objectIdField: 'OBJECTID',
  maxRecordCount: 1000,
  capabilities: 'Query',
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
  minScale: 100000,
  maxScale: 1000,
  spatialReference: { wkid: 3857 },
  drawingInfo: { labelingInfo: [{ labelExpression: '[NAME]' }] },
  fields: [{ name: 'OBJECTID', alias: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false, editable: false }],
}, url);

describe('arcgisLayerAdapter', () => {
  it('creates deterministic renderer-neutral descriptors for 2D and 3D', () => {
    const source = { id: 'parcels', contract: metadata(), opacity: 0.6 };
    expect(adaptArcGisLayer(source, '2d')).toMatchObject({ id: 'parcels', kind: 'feature', mode: '2d', opacity: 0.6, queryable: true, selectable: true });
    expect(adaptArcGisLayer(source, '3d')).toMatchObject({ id: 'parcels', mode: '3d', resourceUrl: source.contract.resourceUrl });
  });

  it('classifies concrete MapServer layer resources without inventing endpoints', () => {
    const descriptor = adaptArcGisLayer({ id: 'zoning', contract: metadata('https://example.test/arcgis/rest/services/Zoning/MapServer/4') }, '2d');
    expect(descriptor.kind).toBe('map-image');
    expect(descriptor.resourceUrl).toBe('https://example.test/arcgis/rest/services/Zoning/MapServer/4');
  });

  it('clamps opacity and fails closed for malformed scale checks', () => {
    const high = adaptArcGisLayer({ id: 'a', contract: metadata(), opacity: 7 }, '2d');
    const low = adaptArcGisLayer({ id: 'b', contract: metadata(), opacity: -3 }, '2d');
    expect(high.opacity).toBe(1);
    expect(low.opacity).toBe(0);
    expect(isLayerVisibleAtScale(high, Number.NaN)).toBe(false);
    expect(isLayerVisibleAtScale(high, 200000)).toBe(false);
    expect(isLayerVisibleAtScale(high, 500)).toBe(false);
    expect(isLayerVisibleAtScale(high, 5000)).toBe(true);
  });

  it('rejects duplicate ids and oversized layer collections', () => {
    const contract = metadata();
    expect(() => adaptArcGisLayers([{ id: 'a', contract }, { id: 'a', contract }], '2d')).toThrow(ArcGisLayerAdapterError);
    expect(() => adaptArcGisLayers([{ id: 'a', contract }, { id: 'b', contract }], '2d', 1)).toThrowError(/bounded maximum/);
  });

  it('rejects invalid ids and invalid explicit scale ranges', () => {
    const contract = metadata();
    expect(() => adaptArcGisLayer({ id: ' ', contract }, '2d')).toThrowError(/non-empty/);
    expect(() => adaptArcGisLayer({ id: 'a', contract, minScale: 100, maxScale: 1000 }, '2d')).toThrowError(/minScale/);
  });

  it('disables query-driven interaction when metadata is not query ready', () => {
    const contract = Object.freeze({ ...metadata(), queryReady: false, identityReady: false });
    const descriptor = adaptArcGisLayer({ id: 'readonly', contract }, '3d');
    expect(descriptor.queryable).toBe(false);
    expect(descriptor.selectable).toBe(false);
    expect(descriptor.popupEnabled).toBe(false);
  });
});
