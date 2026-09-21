import type { RootState } from '../contracts';
import {
  normalizeStoreRuntimeLimits,
  type StoreInvariantIssue,
  type StoreInvariantReport,
  type StoreInvariantSeverity,
  type StoreRuntimeLimits,
  type StoreSliceName,
} from './contracts';

type MutableIssue = {
  code: string;
  severity: StoreInvariantSeverity;
  slice: StoreSliceName | 'root';
  detail: string;
};

const issue = (
  code: string,
  severity: StoreInvariantSeverity,
  slice: StoreSliceName | 'root',
  detail: string,
): MutableIssue => ({ code, severity, slice, detail });

const countMessageLength = (state: RootState): number => {
  const message = state.Common.Message;
  if (!message) return 0;
  const text = message.messageText ?? message.message ?? message.Message ?? '';
  return String(text ?? '').length;
};

const countBySeverity = (
  issues: readonly StoreInvariantIssue[],
  severity: StoreInvariantSeverity,
): number => issues.filter((item) => item.severity === severity).length;

export const inspectStoreInvariants = (
  state: RootState,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
  generatedAt = Date.now(),
): StoreInvariantReport => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  const issues: MutableIssue[] = [];

  const push = (entry: MutableIssue): void => {
    if (issues.length < limits.maxInvariantIssues) issues.push(entry);
  };

  if (!state || typeof state !== 'object') {
    push(issue('STORE_ROOT_INVALID', 'error', 'root', 'Root state is not an object.'));
  }

  const windows = Array.isArray(state.Common?.WindowList) ? state.Common.WindowList : [];
  if (windows.length > limits.maxWindows) {
    push(issue(
      'STORE_WINDOWS_LIMIT',
      'error',
      'Common',
      'Window count exceeds the configured state budget.',
    ));
  }

  const seenWindowIds = new Set<string>();
  let visibleWindows = 0;
  for (const window of windows) {
    const id = String(window?.id ?? '').trim();
    if (!id) {
      push(issue('STORE_WINDOW_ID_REQUIRED', 'warning', 'Common', 'Window registration has an empty id.'));
      continue;
    }
    if (seenWindowIds.has(id)) {
      push(issue('STORE_WINDOW_ID_DUPLICATE', 'error', 'Common', 'Duplicate window id detected.'));
    }
    seenWindowIds.add(id);
    if (window.visible === true) visibleWindows += 1;
  }
  if (visibleWindows > limits.maxVisibleWindows) {
    push(issue(
      'STORE_VISIBLE_WINDOWS_LIMIT',
      'warning',
      'Common',
      'Visible window count exceeds the configured presentation budget.',
    ));
  }

  const services = Array.isArray(state.Common?.ConfigurationServices)
    ? state.Common.ConfigurationServices
    : [];
  if (services.length > limits.maxServices) {
    push(issue(
      'STORE_SERVICES_LIMIT',
      'error',
      'Common',
      'Configuration service count exceeds the configured state budget.',
    ));
  }

  if (countMessageLength(state) > limits.maxMessageLength) {
    push(issue(
      'STORE_MESSAGE_LENGTH',
      'warning',
      'Common',
      'Message text exceeds the configured state budget.',
    ));
  }

  const graphics = Array.isArray(state.Map?.Graphics) ? state.Map.Graphics : [];
  if (graphics.length > limits.maxGraphics) {
    push(issue(
      'STORE_GRAPHICS_LIMIT',
      'error',
      'Map',
      'Map graphics count exceeds the configured state budget.',
    ));
  }
  if (typeof state.Map?.MapClick !== 'function') {
    push(issue(
      'STORE_MAP_CLICK_HANDLER',
      'error',
      'Map',
      'Map click handler is not callable.',
    ));
  }

  const dynamicLayers = Array.isArray(state.DynamicLayers?.List)
    ? state.DynamicLayers.List
    : [];
  if (dynamicLayers.length > limits.maxDynamicLayers) {
    push(issue(
      'STORE_DYNAMIC_LAYERS_LIMIT',
      'error',
      'DynamicLayers',
      'Dynamic layer count exceeds the configured state budget.',
    ));
  }

  if (typeof state.ContextMenu?.ActiveOnLeftClick !== 'boolean') {
    push(issue(
      'STORE_CONTEXT_MENU_FLAG',
      'error',
      'ContextMenu',
      'Context-menu activation flag is not boolean.',
    ));
  }

  const frozen = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
  const errorCount = countBySeverity(frozen, 'error');
  const warningCount = countBySeverity(frozen, 'warning');
  const infoCount = countBySeverity(frozen, 'info');
  const truncated = issues.length >= limits.maxInvariantIssues;

  return Object.freeze({
    generatedAt,
    healthy: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    truncated,
    issues: frozen,
  });
};

export const changedStoreSlices = (
  previousState: RootState,
  nextState: RootState,
): readonly StoreSliceName[] => {
  const changed: StoreSliceName[] = [];
  if (previousState.Common !== nextState.Common) changed.push('Common');
  if (previousState.Map !== nextState.Map) changed.push('Map');
  if (previousState.ContextMenu !== nextState.ContextMenu) changed.push('ContextMenu');
  if (previousState.DynamicLayers !== nextState.DynamicLayers) changed.push('DynamicLayers');
  return Object.freeze(changed);
};
