export type ArcGisGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent' | 'unknown';

export type ArcGisSpatialReference = Readonly<{
  wkid?: number;
  wkt?: string;
}>;

export type ArcGisEnvelope = Readonly<{
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: ArcGisSpatialReference;
}>;

export type ArcGisQueryCapability =
  | 'query'
  | 'pagination'
  | 'order-by'
  | 'statistics'
  | 'distinct'
  | 'extent'
  | 'centroid'
  | 'quantization';

export type ArcGisLayerCapabilities = Readonly<{
  resourceUrl: string;
  objectIdField: string | null;
  maxRecordCount: number;
  geometryType: ArcGisGeometryType;
  spatialReference: ArcGisSpatialReference | null;
  capabilities: ReadonlySet<ArcGisQueryCapability>;
}>;

export type ArcGisQueryWindow = Readonly<{
  resultOffset: number;
  resultRecordCount: number;
}>;

export type ArcGisOrderBy = Readonly<{
  field: string;
  direction: 'ASC' | 'DESC';
}>;

export type ArcGisQuerySpec = Readonly<{
  where: string;
  outFields: readonly string[];
  returnGeometry: boolean;
  geometry?: ArcGisEnvelope;
  geometryType?: 'esriGeometryEnvelope';
  spatialRel?: 'esriSpatialRelIntersects' | 'esriSpatialRelContains' | 'esriSpatialRelWithin';
  outSpatialReference?: ArcGisSpatialReference;
  orderBy?: readonly ArcGisOrderBy[];
  window?: ArcGisQueryWindow;
}>;

export type ArcGisQueryPlan = Readonly<{
  resourceUrl: string;
  queryUrl: string;
  method: 'POST';
  body: URLSearchParams;
  pageSize: number;
  stableOrder: boolean;
  pagination: boolean;
}>;

export class ArcGisQueryContractError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARCGIS_QUERY_CONTRACT_ERROR') {
    super(message);
    this.name = 'ArcGisQueryContractError';
    this.code = code;
  }
}

const positiveInteger = (value: unknown, fallback: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.floor(numeric));
};

const fieldName = (value: unknown): string => {
  const candidate = String(value ?? '').trim();
  if (!candidate || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(candidate)) {
    throw new ArcGisQueryContractError('ArcGIS field name is invalid.', 'INVALID_FIELD_NAME');
  }
  return candidate;
};

const normalizeWhere = (value: unknown): string => {
  const where = String(value ?? '').trim();
  if (!where) return '1=1';
  if (where.length > 16_384) {
    throw new ArcGisQueryContractError('ArcGIS where clause exceeds the bounded query contract.', 'WHERE_TOO_LONG');
  }
  return where;
};

const normalizeSpatialReference = (value: ArcGisSpatialReference | undefined): string | null => {
  if (!value) return null;
  if (Number.isInteger(value.wkid) && Number(value.wkid) > 0) return String(value.wkid);
  const wkt = String(value.wkt ?? '').trim();
  if (wkt) return wkt;
  return null;
};

const normalizeEnvelope = (value: ArcGisEnvelope): string => {
  const numbers = [value.xmin, value.ymin, value.xmax, value.ymax].map(Number);
  if (!numbers.every(Number.isFinite) || numbers[0]! > numbers[2]! || numbers[1]! > numbers[3]!) {
    throw new ArcGisQueryContractError('ArcGIS query envelope is invalid.', 'INVALID_QUERY_ENVELOPE');
  }
  return numbers.join(',');
};

export const createArcGisQueryPlan = (
  capabilities: ArcGisLayerCapabilities,
  spec: ArcGisQuerySpec,
): ArcGisQueryPlan => {
  if (!capabilities.capabilities.has('query')) {
    throw new ArcGisQueryContractError('ArcGIS resource does not advertise query capability.', 'QUERY_UNSUPPORTED');
  }
  const resourceUrl = capabilities.resourceUrl.replace(/\/+$/, '');
  if (!/\/(?:FeatureServer|MapServer)\/\d+$/i.test(resourceUrl)) {
    throw new ArcGisQueryContractError('Queries require a verified ArcGIS layer resource URL.', 'INVALID_LAYER_RESOURCE');
  }
  const body = new URLSearchParams();
  body.set('f', 'json');
  body.set('where', normalizeWhere(spec.where));
  body.set('outFields', spec.outFields.length ? spec.outFields.map(fieldName).join(',') : '*');
  body.set('returnGeometry', spec.returnGeometry ? 'true' : 'false');

  if (spec.geometry) {
    body.set('geometry', normalizeEnvelope(spec.geometry));
    body.set('geometryType', spec.geometryType ?? 'esriGeometryEnvelope');
    body.set('spatialRel', spec.spatialRel ?? 'esriSpatialRelIntersects');
    const inSr = normalizeSpatialReference(spec.geometry.spatialReference);
    if (inSr) body.set('inSR', inSr);
  }
  const outSr = normalizeSpatialReference(spec.outSpatialReference);
  if (outSr) body.set('outSR', outSr);

  const maxRecordCount = positiveInteger(capabilities.maxRecordCount, 1000, 10_000);
  const requestedPageSize = positiveInteger(spec.window?.resultRecordCount, maxRecordCount, maxRecordCount);
  const pagination = capabilities.capabilities.has('pagination');
  if (spec.window && pagination) {
    body.set('resultOffset', String(Math.max(0, Math.floor(spec.window.resultOffset))));
    body.set('resultRecordCount', String(requestedPageSize));
  }

  let stableOrder = false;
  if (spec.orderBy?.length) {
    if (!capabilities.capabilities.has('order-by')) {
      throw new ArcGisQueryContractError('ArcGIS resource does not advertise orderBy capability.', 'ORDER_BY_UNSUPPORTED');
    }
    body.set('orderByFields', spec.orderBy.map((item) => `${fieldName(item.field)} ${item.direction}`).join(','));
    stableOrder = true;
  } else if (pagination && capabilities.objectIdField && capabilities.capabilities.has('order-by')) {
    body.set('orderByFields', `${fieldName(capabilities.objectIdField)} ASC`);
    stableOrder = true;
  }

  return Object.freeze({
    resourceUrl,
    queryUrl: `${resourceUrl}/query`,
    method: 'POST' as const,
    body,
    pageSize: requestedPageSize,
    stableOrder,
    pagination,
  });
};
