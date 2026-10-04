import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import type { WorkspaceSelectionSnapshot } from './ArcGisResultWorkspaceSelectionExperiencePolicy';
import {
  applyArcGisResultWorkspaceViewportIntent,
  type WorkspaceViewportAlignment,
  type WorkspaceViewportSnapshot,
  type WorkspaceViewportTransition,
} from './ArcGisResultWorkspaceViewportExperiencePolicy';

export type WorkspaceSelectionViewportReason =
  | 'selection-empty'
  | 'selection-visible'
  | 'selection-reveal'
  | 'selection-not-admitted';

export interface WorkspaceSelectionViewportOptions {
  readonly alignment?: WorkspaceViewportAlignment;
  readonly announceReveal?: boolean;
}

export interface WorkspaceSelectionViewportCoordination {
  readonly viewport: WorkspaceViewportSnapshot;
  readonly transition: WorkspaceViewportTransition | null;
  readonly targetId: string | null;
  readonly targetIndex: number;
  readonly admitted: boolean;
  readonly rendered: boolean;
  readonly visible: boolean;
  readonly scrollRequired: boolean;
  readonly scrollTop: number;
  readonly reason: WorkspaceSelectionViewportReason;
  readonly announcement: string;
}

const MAX_ANNOUNCEMENT = 240;
const cleanText = (value: unknown): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_ANNOUNCEMENT);

const stateFor = (viewport: WorkspaceViewportSnapshot, rowId: string | null) => {
  const rowIndex = rowId ? viewport.rowIds.indexOf(rowId) : -1;
  return Object.freeze({
    rowIndex,
    admitted: rowIndex >= 0,
    rendered: rowIndex >= viewport.range.startIndex && rowIndex <= viewport.range.endIndex,
    visible: rowIndex >= viewport.range.visibleStartIndex && rowIndex <= viewport.range.visibleEndIndex,
  });
};

const chooseTarget = (selection: WorkspaceSelectionSnapshot, viewport: WorkspaceViewportSnapshot): string | null => {
  if (selection.focusedId && selection.selectedIds.includes(selection.focusedId)) return selection.focusedId;
  for (const id of selection.selectedIds) if (viewport.rowIds.includes(id)) return id;
  return selection.selectedIds[0] ?? null;
};

/**
 * Coordinates selection focus with the governed virtual viewport. Selection
 * remains the authority for selected/focused ids; viewport remains the sole
 * authority for scroll geometry and reveal behavior.
 */
export function coordinateArcGisResultWorkspaceSelectionViewport(
  workspace: ResultWorkspaceSnapshot,
  viewport: WorkspaceViewportSnapshot,
  selection: WorkspaceSelectionSnapshot,
  options: WorkspaceSelectionViewportOptions = {},
): WorkspaceSelectionViewportCoordination {
  const targetId = chooseTarget(selection, viewport);
  const before = stateFor(viewport, targetId);
  if (!targetId) {
    return Object.freeze({ viewport, transition: null, targetId: null, ...before, scrollRequired: false, scrollTop: viewport.scrollTop, reason: 'selection-empty' as const, announcement: '' });
  }
  if (!before.admitted) {
    return Object.freeze({ viewport, transition: null, targetId, ...before, scrollRequired: false, scrollTop: viewport.scrollTop, reason: 'selection-not-admitted' as const, announcement: '' });
  }
  if (before.visible) {
    return Object.freeze({ viewport, transition: null, targetId, ...before, scrollRequired: false, scrollTop: viewport.scrollTop, reason: 'selection-visible' as const, announcement: '' });
  }

  const transition = applyArcGisResultWorkspaceViewportIntent(workspace, viewport, {
    type: 'focus-row',
    rowId: targetId,
    alignment: options.alignment ?? 'nearest',
  });
  const after = stateFor(transition.next, targetId);
  const announcement = options.announceReveal
    ? cleanText(`Seçili sonuç görünür alana getirildi. ${transition.next.accessibility.announcement}`)
    : '';
  return Object.freeze({
    viewport: transition.next,
    transition,
    targetId,
    ...after,
    scrollRequired: transition.scrollRequired,
    scrollTop: transition.scrollTop,
    reason: 'selection-reveal' as const,
    announcement,
  });
}

export function getArcGisResultWorkspaceSelectionViewportState(
  selection: WorkspaceSelectionSnapshot,
  viewport: WorkspaceViewportSnapshot,
): Readonly<{
  selectedCount: number;
  admittedSelectedCount: number;
  renderedSelectedCount: number;
  visibleSelectedCount: number;
  hiddenSelectedCount: number;
}> {
  let admittedSelectedCount = 0;
  let renderedSelectedCount = 0;
  let visibleSelectedCount = 0;
  for (const id of selection.selectedIds) {
    const state = stateFor(viewport, id);
    if (state.admitted) admittedSelectedCount += 1;
    if (state.rendered) renderedSelectedCount += 1;
    if (state.visible) visibleSelectedCount += 1;
  }
  return Object.freeze({
    selectedCount: selection.selectedCount,
    admittedSelectedCount,
    renderedSelectedCount,
    visibleSelectedCount,
    hiddenSelectedCount: Math.max(0, selection.selectedCount - visibleSelectedCount),
  });
}
