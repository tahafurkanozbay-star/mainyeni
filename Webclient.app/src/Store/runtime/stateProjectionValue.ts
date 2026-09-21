import type {
  SafeJsonValue,
  SafeMessageSnapshot,
  SafeServiceSnapshot,
  SafeWindowSnapshot,
  StoreStateProjection,
} from './contracts';

const objectValue = (
  entries: readonly (readonly [string, SafeJsonValue])[],
): Readonly<Record<string, SafeJsonValue>> => {
  const output: Record<string, SafeJsonValue> = {};
  for (const [key, value] of entries) output[key] = value;
  return Object.freeze(output);
};

const windowValue = (window: SafeWindowSnapshot): SafeJsonValue =>
  objectValue([
    ['id', window.id],
    ['title', window.title],
    ['visible', window.visible],
    ['minimized', window.minimized],
    ['order', window.order],
    ['lazy', window.lazy],
    ['query', window.query],
  ]);

const serviceValue = (service: SafeServiceSnapshot): SafeJsonValue =>
  objectValue([
    ['key', service.key],
    ['title', service.title],
    ['url', service.url],
    ['type', service.type],
  ]);

const messageValue = (message: SafeMessageSnapshot | null): SafeJsonValue =>
  message === null
    ? null
    : objectValue([
      ['type', message.type],
      ['text', message.text],
    ]);

export const storeProjectionToSafeValue = (
  projection: StoreStateProjection,
): SafeJsonValue => objectValue([
  ['schemaVersion', projection.schemaVersion],
  ['common', objectValue([
    ['moduleSelectBarVisible', projection.common.moduleSelectBarVisible],
    ['windows', Object.freeze(projection.common.windows.map(windowValue))],
    ['mapConfiguration', projection.common.mapConfiguration],
    ['services', Object.freeze(projection.common.services.map(serviceValue))],
    ['message', messageValue(projection.common.message)],
  ])],
  ['map', objectValue([
    ['isUpdating', projection.map.isUpdating],
    ['mobileRightClickEnabled', projection.map.mobileRightClickEnabled],
    ['graphicsCount', projection.map.graphicsCount],
    ['hasMapView', projection.map.hasMapView],
    ['hasMapClickHandler', projection.map.hasMapClickHandler],
  ])],
  ['contextMenu', objectValue([
    ['activeOnLeftClick', projection.contextMenu.activeOnLeftClick],
  ])],
  ['dynamicLayers', objectValue([
    ['count', projection.dynamicLayers.count],
  ])],
]);
