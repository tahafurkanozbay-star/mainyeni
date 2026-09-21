import type { ServiceDescriptor } from '../../Business/contracts';
import type { RootState, WindowRegistration } from '../contracts';
import {
  normalizeStoreRuntimeLimits,
  type SafeJsonValue,
  type SafeMessageSnapshot,
  type SafeServiceSnapshot,
  type SafeWindowSnapshot,
  type StoreRuntimeLimits,
  type StoreStateProjection,
} from './contracts';

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|session)/i;

type ProjectionBudget = {
  entries: number;
  truncated: boolean;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeText = (value: unknown, maxLength: number): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
};

const normalizeNumber = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const safePrimitive = (value: unknown, maxTextLength: number): SafeJsonValue | undefined => {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, maxTextLength);
  if (typeof value === 'bigint') return String(value).slice(0, maxTextLength);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  return undefined;
};

const sanitizeValueInternal = (
  value: unknown,
  limits: StoreRuntimeLimits,
  budget: ProjectionBudget,
  depth: number,
  seen: WeakSet<object>,
): SafeJsonValue | undefined => {
  const primitive = safePrimitive(value, limits.maxProjectionTextLength);
  if (primitive !== undefined) return primitive;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= limits.maxProjectionDepth) {
    budget.truncated = true;
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) {
    budget.truncated = true;
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output: SafeJsonValue[] = [];
    for (const item of value) {
      if (budget.entries >= limits.maxProjectionEntries) {
        budget.truncated = true;
        break;
      }
      budget.entries += 1;
      const safe = sanitizeValueInternal(item, limits, budget, depth + 1, seen);
      if (safe !== undefined) output.push(safe);
    }
    return Object.freeze(output);
  }

  if (!isRecord(value)) return undefined;
  const output: Record<string, SafeJsonValue> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
    if (budget.entries >= limits.maxProjectionEntries) {
      budget.truncated = true;
      break;
    }
    if (SENSITIVE_KEY.test(key)) continue;
    budget.entries += 1;
    const safe = sanitizeValueInternal(value[key], limits, budget, depth + 1, seen);
    if (safe !== undefined) output[key.slice(0, 160)] = safe;
  }
  return Object.freeze(output);
};

export const sanitizeStoreValue = (
  value: unknown,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
): Readonly<{ value: SafeJsonValue | null; truncated: boolean; entries: number }> => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  const budget: ProjectionBudget = { entries: 0, truncated: false };
  const safe = sanitizeValueInternal(value, limits, budget, 0, new WeakSet<object>());
  return Object.freeze({
    value: safe ?? null,
    truncated: budget.truncated,
    entries: budget.entries,
  });
};

const projectWindow = (
  value: WindowRegistration,
  limits: StoreRuntimeLimits,
): SafeWindowSnapshot => {
  const safeQuery = sanitizeStoreValue(value.query ?? null, limits).value;
  return Object.freeze({
    id: String(value.id ?? '').slice(0, 160),
    title: normalizeText(value.title, limits.maxProjectionTextLength),
    visible: value.visible === true,
    minimized: value.minimized === true,
    order: normalizeNumber(value.order),
    lazy: value.lazy === true,
    query: safeQuery,
  });
};

const readServiceField = (
  service: ServiceDescriptor,
  keys: readonly string[],
  maxLength: number,
): string | null => {
  const record = service as Readonly<Record<string, unknown>>;
  for (const key of keys) {
    const normalized = normalizeText(record[key], maxLength);
    if (normalized !== null) return normalized;
  }
  return null;
};

const projectService = (
  service: ServiceDescriptor,
  limits: StoreRuntimeLimits,
): SafeServiceSnapshot => Object.freeze({
  key: readServiceField(service, ['key', 'id', 'name'], limits.maxProjectionTextLength),
  title: readServiceField(service, ['title', 'Title', 'name'], limits.maxProjectionTextLength),
  url: readServiceField(service, ['url', 'Url'], limits.maxProjectionTextLength),
  type: readServiceField(service, ['type', 'Type', 'layerType'], limits.maxProjectionTextLength),
});

const projectMessage = (
  value: RootState['Common']['Message'],
  limits: StoreRuntimeLimits,
): SafeMessageSnapshot | null => {
  if (!value) return null;
  const type = value.messageType ?? value.type ?? value.Type ?? null;
  const normalizedType = typeof type === 'string' || typeof type === 'number'
    ? type
    : null;
  const text = value.messageText ?? value.message ?? value.Message ?? null;
  return Object.freeze({
    type: normalizedType,
    text: normalizeText(text, limits.maxMessageLength),
  });
};

export const projectStoreState = (
  state: RootState,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
  generatedAt = Date.now(),
): StoreStateProjection => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  const windows = Array.isArray(state.Common.WindowList)
    ? state.Common.WindowList.slice(0, limits.maxWindows).map((item) => projectWindow(item, limits))
    : [];
  const services = Array.isArray(state.Common.ConfigurationServices)
    ? state.Common.ConfigurationServices.slice(0, limits.maxServices).map((item) => projectService(item, limits))
    : [];

  return Object.freeze({
    schemaVersion: 1,
    generatedAt,
    common: Object.freeze({
      moduleSelectBarVisible: state.Common.ModuleSelectBarVisible === true,
      windows: Object.freeze(windows),
      mapConfiguration: sanitizeStoreValue(state.Common.MapConfiguration, limits).value,
      services: Object.freeze(services),
      message: projectMessage(state.Common.Message, limits),
    }),
    map: Object.freeze({
      isUpdating: state.Map.IsUpdating === true,
      mobileRightClickEnabled: state.Map.MobileRightClickEnabled === true,
      graphicsCount: Array.isArray(state.Map.Graphics) ? state.Map.Graphics.length : 0,
      hasMapView: state.Map.MapView !== null && state.Map.MapView !== undefined,
      hasMapClickHandler: typeof state.Map.MapClick === 'function',
    }),
    contextMenu: Object.freeze({
      activeOnLeftClick: state.ContextMenu.ActiveOnLeftClick === true,
    }),
    dynamicLayers: Object.freeze({
      count: Array.isArray(state.DynamicLayers.List) ? state.DynamicLayers.List.length : 0,
    }),
  });
};
