import {
  resolveArcGisResultWorkspaceShortcut,
  type ResultWorkspaceShortcutAction,
  type ResultWorkspaceShortcutContext,
  type ResultWorkspaceShortcutEvent,
  type ResultWorkspaceShortcutResolution,
} from './ArcGisResultWorkspaceShortcutExperiencePolicy';
import type { ResultWorkspaceIntent, ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

export type WorkspaceCommandFocusTarget = 'map' | 'results' | 'filters' | 'detail' | 'selection' | null;

export interface WorkspaceCommandDispatchContext {
  readonly snapshot: ResultWorkspaceSnapshot;
  readonly event: ResultWorkspaceShortcutEvent;
  readonly landmarkIds?: readonly string[];
  readonly activeLandmarkId?: string;
}

export interface WorkspaceCommandDispatch {
  readonly shortcut: ResultWorkspaceShortcutResolution;
  readonly intent: ResultWorkspaceIntent | null;
  readonly focusTarget: WorkspaceCommandFocusTarget;
  readonly focusElementId: string | null;
  readonly announcement: string;
  readonly handled: boolean;
  readonly preventDefault: boolean;
}

const MAX_LANDMARKS = 12;
const MAX_ID = 96;

const cleanId = (value: unknown): string =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ID);

function landmarks(values: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    if (result.length >= MAX_LANDMARKS) break;
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
}

function shortcutContext(snapshot: ResultWorkspaceSnapshot): ResultWorkspaceShortcutContext {
  return Object.freeze({
    detailOpen: snapshot.interaction.detailOpen,
    filterOpen: snapshot.interaction.filterOpen,
    hasFocusedResult: Boolean(snapshot.interaction.focusedId),
    hasResults: snapshot.interaction.resultIds.length > 0,
    viewport: snapshot.interaction.viewport,
  });
}

function landmarkTarget(
  action: 'next-landmark' | 'previous-landmark',
  values: readonly string[],
  activeId: string,
): string | null {
  if (!values.length) return null;
  const index = values.indexOf(activeId);
  if (index < 0) return action === 'next-landmark' ? values[0] : values[values.length - 1];
  const delta = action === 'next-landmark' ? 1 : -1;
  return values[(index + delta + values.length) % values.length] ?? null;
}

function intentForAction(action: ResultWorkspaceShortcutAction, snapshot: ResultWorkspaceSnapshot): ResultWorkspaceIntent | null {
  if (action === 'focus-map') return Object.freeze({ type: 'show-map' });
  if (action === 'focus-results') return Object.freeze({ type: 'show-results' });
  if (action === 'toggle-filters') return Object.freeze({ type: 'toggle-filters' });
  if (action === 'open-detail' && snapshot.interaction.focusedId) {
    return Object.freeze({ type: 'open-detail', resultId: snapshot.interaction.focusedId });
  }
  if (action === 'toggle-selection' && snapshot.interaction.focusedId) {
    return Object.freeze({ type: 'toggle-selection', resultId: snapshot.interaction.focusedId });
  }
  if (action === 'close-surface') {
    if (snapshot.interaction.detailOpen) return Object.freeze({ type: 'close-detail' });
    if (snapshot.interaction.filterOpen) return Object.freeze({ type: 'close-filters' });
  }
  return null;
}

function focusForAction(action: ResultWorkspaceShortcutAction): WorkspaceCommandFocusTarget {
  if (action === 'focus-map') return 'map';
  if (action === 'focus-results') return 'results';
  if (action === 'toggle-filters') return 'filters';
  if (action === 'open-detail') return 'detail';
  if (action === 'toggle-selection') return 'selection';
  if (action === 'close-surface') return 'results';
  return null;
}

export function dispatchArcGisResultWorkspaceCommand(context: WorkspaceCommandDispatchContext): WorkspaceCommandDispatch {
  const shortcut = resolveArcGisResultWorkspaceShortcut(context.event, shortcutContext(context.snapshot));
  if (!shortcut.handled || !shortcut.action) {
    return Object.freeze({
      shortcut,
      intent: null,
      focusTarget: null,
      focusElementId: null,
      announcement: '',
      handled: false,
      preventDefault: false,
    });
  }

  if (shortcut.action === 'next-landmark' || shortcut.action === 'previous-landmark') {
    const focusElementId = landmarkTarget(shortcut.action, landmarks(context.landmarkIds), cleanId(context.activeLandmarkId));
    return Object.freeze({
      shortcut,
      intent: null,
      focusTarget: null,
      focusElementId,
      announcement: shortcut.announcement,
      handled: Boolean(focusElementId),
      preventDefault: Boolean(focusElementId),
    });
  }

  const intent = intentForAction(shortcut.action, context.snapshot);
  return Object.freeze({
    shortcut,
    intent,
    focusTarget: focusForAction(shortcut.action),
    focusElementId: null,
    announcement: shortcut.announcement,
    handled: Boolean(intent),
    preventDefault: Boolean(intent),
  });
}
