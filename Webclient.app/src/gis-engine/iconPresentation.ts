import iconEntries from './iconRegistry.json';
import { buildIconRegistry, resolveIcon } from './iconResolver';
import type {
  Graphic3DModel,
  IconRecord,
  IconResolveOptions,
  ListIconModel,
  PictureMarkerOptions,
  PictureMarkerSymbolModel,
  ResolvedIconEntry,
} from './contracts';

const DEFAULT_MARKER_URL = 'images/icons/map/pictureMarker.png';
const registry = buildIconRegistry(iconEntries);

export const getSharedIconRegistry = () => registry;

export const resolveRecordIcon = (
  record: IconRecord = {},
  options: IconResolveOptions = {},
): ResolvedIconEntry => resolveIcon(record || {}, registry, options);

const resolvedIconUrl = (
  resolved: ResolvedIconEntry,
  options: IconResolveOptions = {},
): string => resolved.url || resolved.src || resolved.icon || options.fallback || DEFAULT_MARKER_URL;

export const resolveRecordIconUrl = (
  record: IconRecord,
  options: IconResolveOptions = {},
): string => resolvedIconUrl(resolveRecordIcon(record, options), options);

export const createPictureMarkerSymbol = (
  record: IconRecord,
  zoom = 12,
  options: PictureMarkerOptions = {},
): PictureMarkerSymbolModel => {
  const min = Number.isFinite(options.minSize) ? Number(options.minSize) : 28;
  const max = Number.isFinite(options.maxSize) ? Number(options.maxSize) : 56;
  const threshold = Number.isFinite(options.zoomThreshold) ? Number(options.zoomThreshold) : 10;
  const size = zoom >= threshold ? min : max;
  return {
    type: 'picture-marker',
    url: resolveRecordIconUrl(record, options),
    width: `${size}px`,
    height: `${Math.round(size * 1.15)}px`,
    angle: Number.isFinite(record?.angle) ? Number(record.angle) : 0,
  };
};

export const getIconKey = (
  record: IconRecord,
  options: IconResolveOptions = {},
): string => resolveRecordIcon(record, options).id || options.fallback || 'default';

export const createListIconModel = (
  record: IconRecord,
  options: IconResolveOptions = {},
): ListIconModel => {
  const resolved = resolveRecordIcon(record, options);
  return {
    key: resolved.id || options.fallback || 'default',
    src: resolvedIconUrl(resolved, options),
    alt: String(record?.title || record?.name || resolved.category || resolved.type || 'Harita nesnesi'),
    isFallback: Boolean(resolved.isFallback),
    matchedBy: resolved.matchedBy || null,
  };
};

export const create3DGraphicModel = (
  record: IconRecord,
  options: IconResolveOptions = {},
): Graphic3DModel => {
  const resolved = resolveRecordIcon(record, options);
  return {
    iconKey: resolved.id || options.fallback || 'default',
    billboard: resolvedIconUrl(resolved, options),
    label: String(record?.title || record?.name || resolved.category || resolved.type || ''),
    isFallback: Boolean(resolved.isFallback),
  };
};
