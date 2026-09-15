import iconEntries from './iconRegistry.json';
import { buildIconRegistry, resolveIcon } from './iconResolver';

const registry = buildIconRegistry(iconEntries);

export const getSharedIconRegistry = () => registry;

export const resolveRecordIcon = (record, options = {}) => {
  return resolveIcon(record || {}, registry, options);
};

export const resolveRecordIconUrl = (record, options = {}) => {
  const resolved = resolveRecordIcon(record, options);
  return resolved.url || resolved.src || resolved.icon || options.fallback || 'images/icons/map/pictureMarker.png';
};

export const createPictureMarkerSymbol = (record, zoom = 12, options = {}) => {
  const min = Number.isFinite(options.minSize) ? options.minSize : 28;
  const max = Number.isFinite(options.maxSize) ? options.maxSize : 56;
  const threshold = Number.isFinite(options.zoomThreshold) ? options.zoomThreshold : 10;
  const size = zoom >= threshold ? min : max;
  return {
    type: 'picture-marker',
    url: resolveRecordIconUrl(record, options),
    width: `${size}px`,
    height: `${Math.round(size * 1.15)}px`,
    angle: Number.isFinite(record?.angle) ? record.angle : 0,
  };
};

export const getIconKey = (record, options = {}) => resolveRecordIcon(record, options).id || options.fallback || 'default';

export const createListIconModel = (record, options = {}) => {
  const resolved = resolveRecordIcon(record, options);
  return {
    key: resolved.id || options.fallback || 'default',
    src: resolvedIconUrl(resolved, options),
    alt: String(record?.title || record?.name || resolved.category || resolved.type || 'Harita nesnesi'),
    isFallback: Boolean(resolved.isFallback),
    matchedBy: resolved.matchedBy || null,
  };
};

const resolvedIconUrl = (resolved, options = {}) => resolved.url || resolved.src || resolved.icon || options.fallback || 'images/icons/map/pictureMarker.png';

export const create3DGraphicModel = (record, options = {}) => {
  const resolved = resolveRecordIcon(record, options);
  return {
    iconKey: resolved.id || options.fallback || 'default',
    billboard: resolvedIconUrl(resolved, options),
    label: String(record?.title || record?.name || resolved.category || resolved.type || ''),
    isFallback: Boolean(resolved.isFallback),
  };
};
