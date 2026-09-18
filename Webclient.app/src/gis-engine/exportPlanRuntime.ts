import {
  createDeterministicFingerprint,
  normalizeIdentifier,
  positiveInteger,
} from './runtimeContracts';

export type GisExportFormat = 'png' | 'jpeg' | 'pdf';
export type GisExportOrientation = 'portrait' | 'landscape';
export type GisExportPageSize = 'a4' | 'a3' | 'letter' | 'custom';
export type GisExportRenderStrategy =
  | 'map-screenshot'
  | 'scene-screenshot'
  | 'composed-document';

export interface GisExportLayerInput {
  readonly layerId: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly order?: number;
  readonly title?: string | null;
}

export interface GisExportExtentInput {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly spatialReferenceWkid: number;
}

export interface GisExportPlanInput {
  readonly mode: '2d' | '3d';
  readonly format: GisExportFormat;
  readonly pageSize?: GisExportPageSize;
  readonly orientation?: GisExportOrientation;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly dpi?: number;
  readonly jpegQuality?: number;
  readonly title?: string | null;
  readonly scale?: number | null;
  readonly extent?: GisExportExtentInput | null;
  readonly includeLegend?: boolean;
  readonly includeScaleBar?: boolean;
  readonly includeAttribution?: boolean;
  readonly transparentBackground?: boolean;
  readonly layers?: readonly GisExportLayerInput[];
}

export interface GisExportLayerPlan {
  readonly layerId: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly order: number;
  readonly title: string | null;
}

export interface GisExportPlan {
  readonly format: GisExportFormat;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'application/pdf';
  readonly mode: '2d' | '3d';
  readonly strategy: GisExportRenderStrategy;
  readonly pageSize: GisExportPageSize;
  readonly orientation: GisExportOrientation;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
  readonly pixelCount: number;
  readonly estimatedWorkingBytes: number;
  readonly jpegQuality: number | null;
  readonly title: string | null;
  readonly scale: number | null;
  readonly extent: Readonly<GisExportExtentInput> | null;
  readonly includeLegend: boolean;
  readonly includeScaleBar: boolean;
  readonly includeAttribution: boolean;
  readonly transparentBackground: boolean;
  readonly layers: readonly GisExportLayerPlan[];
  readonly warnings: readonly string[];
  readonly fingerprint: string;
}

export interface GisExportRuntimeConfiguration {
  readonly maxPixelCount?: number;
  readonly maxDimensionPx?: number;
  readonly maxDpi?: number;
  readonly maxLayers?: number;
  readonly maxWorkingBytes?: number;
  readonly maxTitleLength?: number;
}

export interface GisExportRuntime {
  plan: (input: GisExportPlanInput) => GisExportPlan;
  estimateWorkingBytes: (
    widthPx: number,
    heightPx: number,
    format: GisExportFormat,
  ) => number;
}

interface PageDimensions {
  readonly widthInches: number;
  readonly heightInches: number;
}

const PAGE_DIMENSIONS: Readonly<Record<Exclude<GisExportPageSize, 'custom'>, PageDimensions>> = Object.freeze({
  a4: Object.freeze({ widthInches: 8.2677165354, heightInches: 11.6929133858 }),
  a3: Object.freeze({ widthInches: 11.6929133858, heightInches: 16.5354330709 }),
  letter: Object.freeze({ widthInches: 8.5, heightInches: 11 }),
});

const DEFAULT_DPI = 150;
const DEFAULT_MAX_DPI = 300;
const DEFAULT_MAX_DIMENSION = 16_384;
const DEFAULT_MAX_PIXELS = 48_000_000;
const DEFAULT_MAX_LAYERS = 256;
const DEFAULT_MAX_WORKING_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_TITLE = 512;

const finite = (value: unknown, label: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${label} must be finite.`);
  return numeric;
};

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(maximum, Math.max(minimum, value))
);

const mimeTypeForFormat = (
  format: GisExportFormat,
): GisExportPlan['mimeType'] => {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  return 'application/pdf';
};

const strategyFor = (
  mode: '2d' | '3d',
  format: GisExportFormat,
): GisExportRenderStrategy => {
  if (format === 'pdf') return 'composed-document';
  return mode === '3d' ? 'scene-screenshot' : 'map-screenshot';
};

const normalizeTitle = (
  value: unknown,
  maxLength: number,
): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
};

const normalizeWkid = (value: unknown): number => {
  const numeric = Math.trunc(finite(value, 'Export extent WKID'));
  if (numeric <= 0 || numeric > 10_000_000) {
    throw new RangeError('Export extent WKID is outside the supported range.');
  }
  return numeric;
};

const normalizeExtent = (
  value: GisExportExtentInput | null | undefined,
): Readonly<GisExportExtentInput> | null => {
  if (!value) return null;
  const xmin = finite(value.xmin, 'Export xmin');
  const ymin = finite(value.ymin, 'Export ymin');
  const xmax = finite(value.xmax, 'Export xmax');
  const ymax = finite(value.ymax, 'Export ymax');
  if (xmax <= xmin || ymax <= ymin) {
    throw new RangeError('Export extent must have positive width and height.');
  }
  return Object.freeze({
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReferenceWkid: normalizeWkid(value.spatialReferenceWkid),
  });
};

const normalizeScale = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const numeric = finite(value, 'Export scale');
  if (numeric <= 0) throw new RangeError('Export scale must be positive.');
  return numeric;
};

const normalizeLayer = (
  layer: GisExportLayerInput,
  index: number,
  maxTitleLength: number,
): GisExportLayerPlan => Object.freeze({
  layerId: normalizeIdentifier(layer.layerId, 'layerId'),
  visible: layer.visible !== false,
  opacity: clamp(
    layer.opacity === undefined ? 1 : finite(layer.opacity, 'Layer opacity'),
    0,
    1,
  ),
  order: Math.max(
    0,
    Math.trunc(layer.order === undefined ? index : finite(layer.order, 'Layer order')),
  ),
  title: normalizeTitle(layer.title, maxTitleLength),
});

const resolvePagePixels = (
  pageSize: GisExportPageSize,
  orientation: GisExportOrientation,
  dpi: number,
  widthPx: number | undefined,
  heightPx: number | undefined,
): Readonly<{ widthPx: number; heightPx: number }> => {
  if (pageSize === 'custom') {
    const width = Math.trunc(finite(widthPx, 'Custom export width'));
    const height = Math.trunc(finite(heightPx, 'Custom export height'));
    if (width <= 0 || height <= 0) {
      throw new RangeError('Custom export dimensions must be positive.');
    }
    return Object.freeze({ widthPx: width, heightPx: height });
  }

  const page = PAGE_DIMENSIONS[pageSize];
  const portraitWidth = Math.round(page.widthInches * dpi);
  const portraitHeight = Math.round(page.heightInches * dpi);
  return orientation === 'portrait'
    ? Object.freeze({ widthPx: portraitWidth, heightPx: portraitHeight })
    : Object.freeze({ widthPx: portraitHeight, heightPx: portraitWidth });
};

export const createGisExportRuntime = (
  configuration: GisExportRuntimeConfiguration = {},
): GisExportRuntime => {
  const maxPixelCount = positiveInteger(
    configuration.maxPixelCount,
    DEFAULT_MAX_PIXELS,
    1_000_000_000,
  );
  const maxDimensionPx = positiveInteger(
    configuration.maxDimensionPx,
    DEFAULT_MAX_DIMENSION,
    131_072,
  );
  const maxDpi = positiveInteger(
    configuration.maxDpi,
    DEFAULT_MAX_DPI,
    2400,
  );
  const maxLayers = positiveInteger(
    configuration.maxLayers,
    DEFAULT_MAX_LAYERS,
    10_000,
  );
  const maxWorkingBytes = positiveInteger(
    configuration.maxWorkingBytes,
    DEFAULT_MAX_WORKING_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  const maxTitleLength = positiveInteger(
    configuration.maxTitleLength,
    DEFAULT_MAX_TITLE,
    16_384,
  );

  const estimateWorkingBytes = (
    widthPx: number,
    heightPx: number,
    format: GisExportFormat,
  ): number => {
    const width = Math.max(1, Math.trunc(finite(widthPx, 'Export width')));
    const height = Math.max(1, Math.trunc(finite(heightPx, 'Export height')));
    const pixels = width * height;
    const rgbaBytes = pixels * 4;
    const compositingMultiplier = format === 'pdf' ? 2.25 : format === 'png' ? 1.75 : 1.5;
    return Math.ceil(rgbaBytes * compositingMultiplier);
  };

  const plan = (input: GisExportPlanInput): GisExportPlan => {
    if (!input || (input.mode !== '2d' && input.mode !== '3d')) {
      throw new TypeError('GIS export mode must be either 2d or 3d.');
    }
    if (!['png', 'jpeg', 'pdf'].includes(input.format)) {
      throw new TypeError('Unsupported GIS export format.');
    }

    const format = input.format;
    const pageSize = input.pageSize ?? (
      input.widthPx !== undefined || input.heightPx !== undefined ? 'custom' : 'a4'
    );
    if (!['a4', 'a3', 'letter', 'custom'].includes(pageSize)) {
      throw new TypeError('Unsupported GIS export page size.');
    }
    const orientation: GisExportOrientation = input.orientation === 'landscape'
      ? 'landscape'
      : 'portrait';
    const dpi = clamp(
      Math.trunc(input.dpi === undefined ? DEFAULT_DPI : finite(input.dpi, 'Export DPI')),
      36,
      maxDpi,
    );
    const dimensions = resolvePagePixels(
      pageSize,
      orientation,
      dpi,
      input.widthPx,
      input.heightPx,
    );
    if (dimensions.widthPx > maxDimensionPx || dimensions.heightPx > maxDimensionPx) {
      throw new RangeError(
        `GIS export dimension exceeds the configured maximum (${maxDimensionPx}px).`,
      );
    }

    const pixelCount = dimensions.widthPx * dimensions.heightPx;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixelCount) {
      throw new RangeError(
        `GIS export pixel budget exceeded (${maxPixelCount}).`,
      );
    }

    const estimatedWorkingBytes = estimateWorkingBytes(
      dimensions.widthPx,
      dimensions.heightPx,
      format,
    );
    if (estimatedWorkingBytes > maxWorkingBytes) {
      throw new RangeError(
        `GIS export working-memory budget exceeded (${maxWorkingBytes} bytes).`,
      );
    }

    const layerInputs = input.layers ?? [];
    if (layerInputs.length > maxLayers) {
      throw new RangeError(`GIS export layer budget exceeded (${maxLayers}).`);
    }
    const layers = Object.freeze(
      layerInputs
        .map((layer, index) => normalizeLayer(layer, index, maxTitleLength))
        .sort((left, right) => left.order - right.order
          || left.layerId.localeCompare(right.layerId)),
    );

    const warnings: string[] = [];
    if (input.mode === '3d' && input.transparentBackground === true) {
      warnings.push('3D transparent background support depends on the active SceneView renderer.');
    }
    if (format === 'pdf' && input.mode === '3d') {
      warnings.push('3D PDF output is composed from a raster scene snapshot plus document overlays.');
    }
    if (dpi > 200) {
      warnings.push('High-DPI exports increase GPU readback and browser memory pressure.');
    }
    if (layers.filter((layer) => layer.visible).length > 64) {
      warnings.push('Large visible-layer counts can materially increase export render time.');
    }

    const jpegQuality = format === 'jpeg'
      ? clamp(
        input.jpegQuality === undefined ? 0.9 : finite(input.jpegQuality, 'JPEG quality'),
        0.1,
        1,
      )
      : null;
    const title = normalizeTitle(input.title, maxTitleLength);
    const extent = normalizeExtent(input.extent);
    const scale = normalizeScale(input.scale);
    const includeLegend = input.includeLegend === true;
    const includeScaleBar = input.includeScaleBar !== false;
    const includeAttribution = input.includeAttribution !== false;
    const transparentBackground = format === 'png' && input.transparentBackground === true;
    const strategy = strategyFor(input.mode, format);

    const fingerprint = createDeterministicFingerprint('gis-export-plan', {
      format,
      mode: input.mode,
      strategy,
      pageSize,
      orientation,
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      dpi,
      jpegQuality,
      title,
      scale,
      extent,
      includeLegend,
      includeScaleBar,
      includeAttribution,
      transparentBackground,
      layers,
    });

    return Object.freeze({
      format,
      mimeType: mimeTypeForFormat(format),
      mode: input.mode,
      strategy,
      pageSize,
      orientation,
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      dpi,
      pixelCount,
      estimatedWorkingBytes,
      jpegQuality,
      title,
      scale,
      extent,
      includeLegend,
      includeScaleBar,
      includeAttribution,
      transparentBackground,
      layers,
      warnings: Object.freeze(warnings),
      fingerprint,
    });
  };

  return Object.freeze({
    plan,
    estimateWorkingBytes,
  });
};
