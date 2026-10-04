import type { ResultDetailExperienceModel } from './ArcGisResultDetailExperiencePolicy';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import type { ResultWorkspaceAccessibilityContract } from './ArcGisResultWorkspaceAccessibilityExperiencePolicy';

export type ResultDetailAccessibilityPresentation = 'dialog' | 'complementary';
export type ResultDetailAccessibilityFocusAction = 'focus-heading' | 'focus-section' | 'restore-result' | 'none';

export interface ResultDetailAccessibilityIds {
  readonly surface: string;
  readonly heading: string;
  readonly status: string;
  readonly close: string;
  readonly sectionPrefix: string;
}

export interface ResultDetailAccessibilityContract {
  readonly ids: ResultDetailAccessibilityIds;
  readonly presentation: ResultDetailAccessibilityPresentation;
  readonly role: 'dialog' | 'complementary';
  readonly modal: boolean;
  readonly hidden: boolean;
  readonly ariaLabelledBy: string;
  readonly ariaDescribedBy: string;
  readonly busy: boolean;
  readonly liveRegion: Readonly<{
    role: 'status' | 'alert';
    ariaLive: 'polite' | 'assertive';
    ariaAtomic: true;
    message: string;
  }>;
  readonly sectionIds: readonly string[];
  readonly activeSectionId: string | null;
  readonly focusTarget: string | null;
  readonly focusAction: ResultDetailAccessibilityFocusAction;
  readonly restoreFocusTarget: string;
  readonly focusVisible: boolean;
  readonly minimumTargetSize: 44 | 48;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly revision: number;
}

export interface ResultDetailAccessibilityKeyEvent {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly repeat?: boolean;
  readonly composing?: boolean;
  readonly editable?: boolean;
  readonly defaultPrevented?: boolean;
}

export interface ResultDetailAccessibilityKeyResolution {
  readonly handled: boolean;
  readonly preventDefault: boolean;
  readonly focusTarget: string | null;
  readonly action: 'next-section' | 'previous-section' | 'first-section' | 'last-section' | 'close' | 'none';
}

const MAX_ID = 96;
const MAX_SECTIONS = 16;
const MAX_MESSAGE = 240;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

const cleanId = (value: unknown, fallback: string): string => {
  const source = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const safe = source.replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_ID);
  return safe || fallback;
};

const cleanMessage = (value: unknown): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_MESSAGE);

const nextRevision = (value: number): number => {
  const safe = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return safe >= MAX_REVISION ? 0 : safe + 1;
};

const createIds = (scopeId: string): ResultDetailAccessibilityIds => {
  const scope = cleanId(scopeId, 'arcgis-results');
  return Object.freeze({
    surface: `${scope}-detail`,
    heading: `${scope}-detail-heading`,
    status: `${scope}-detail-status`,
    close: `${scope}-detail-close`,
    sectionPrefix: `${scope}-detail-section`,
  });
};

const sectionIds = (detail: ResultDetailExperienceModel, prefix: string): readonly string[] => Object.freeze(
  detail.sections.slice(0, MAX_SECTIONS).map((section) => `${prefix}-${cleanId(section.id, 'section')}`),
);

const activeSectionElementId = (
  detail: ResultDetailExperienceModel,
  ids: ResultDetailAccessibilityIds,
  admittedSectionIds: readonly string[],
): string | null => {
  if (!detail.selectedSectionId) return admittedSectionIds[0] ?? null;
  const index = detail.sections.findIndex((section) => section.id === detail.selectedSectionId);
  return index >= 0 ? admittedSectionIds[index] ?? null : admittedSectionIds[0] ?? null;
};

const isOverlay = (detail: ResultDetailExperienceModel): boolean => detail.presentation === 'sheet' || detail.presentation === 'drawer';

const restoreTarget = (
  workspace: ResultWorkspaceSnapshot,
  accessibility: ResultWorkspaceAccessibilityContract,
): string => {
  if (workspace.interaction.focusedId && accessibility.activeDescendant) return accessibility.activeDescendant;
  return accessibility.ids.collection;
};

export function createArcGisResultWorkspaceDetailAccessibilityContract(
  workspace: ResultWorkspaceSnapshot,
  accessibility: ResultWorkspaceAccessibilityContract,
  detail: ResultDetailExperienceModel,
  scopeId = 'arcgis-results',
  previous: ResultDetailAccessibilityContract | null = null,
): ResultDetailAccessibilityContract {
  const ids = createIds(scopeId);
  const admittedSections = sectionIds(detail, ids.sectionPrefix);
  const visible = workspace.interaction.detailOpen && workspace.interaction.activeId === detail.resultId;
  const overlay = isOverlay(detail);
  const activeSectionId = activeSectionElementId(detail, ids, admittedSections);
  const restoreFocusTarget = restoreTarget(workspace, accessibility);
  const error = cleanMessage(detail.error);
  const status = cleanMessage(detail.statusAnnouncement);
  const message = error ? `Ayrıntı hatası. ${error}` : status;
  const justOpened = visible && (!previous || previous.hidden);
  const sectionChanged = Boolean(previous && visible && previous.activeSectionId !== activeSectionId);
  const justClosed = Boolean(previous && !previous.hidden && !visible);
  const focusAction: ResultDetailAccessibilityFocusAction = justClosed
    ? 'restore-result'
    : justOpened
      ? 'focus-heading'
      : sectionChanged
        ? 'focus-section'
        : 'none';
  const focusTarget = focusAction === 'restore-result'
    ? restoreFocusTarget
    : focusAction === 'focus-heading'
      ? ids.heading
      : focusAction === 'focus-section'
        ? activeSectionId
        : null;

  return Object.freeze({
    ids,
    presentation: overlay ? 'dialog' : 'complementary',
    role: overlay ? 'dialog' : 'complementary',
    modal: overlay && visible,
    hidden: !visible,
    ariaLabelledBy: ids.heading,
    ariaDescribedBy: ids.status,
    busy: detail.busy,
    liveRegion: Object.freeze({
      role: error ? 'alert' : 'status',
      ariaLive: error ? 'assertive' : 'polite',
      ariaAtomic: true,
      message,
    }),
    sectionIds: admittedSections,
    activeSectionId,
    focusTarget,
    focusAction,
    restoreFocusTarget,
    focusVisible: workspace.modality === 'keyboard',
    minimumTargetSize: workspace.accessibility.minimumTargetSize,
    reducedMotion: workspace.accessibility.reducedMotion,
    forcedColors: workspace.accessibility.forcedColors,
    revision: previous ? nextRevision(previous.revision) : 0,
  });
}

export function shouldTrapArcGisResultWorkspaceDetailFocus(contract: ResultDetailAccessibilityContract): boolean {
  return !contract.hidden && contract.modal;
}

const suppress = (event: ResultDetailAccessibilityKeyEvent): boolean => Boolean(
  event.defaultPrevented
  || event.editable
  || event.composing
  || event.repeat
  || event.ctrlKey
  || event.altKey
  || event.metaKey,
);

const targetByDelta = (
  sectionIdsValue: readonly string[],
  currentTargetId: string | null | undefined,
  delta: number,
): string | null => {
  if (!sectionIdsValue.length) return null;
  const current = cleanId(currentTargetId, '');
  const index = sectionIdsValue.indexOf(current);
  if (index < 0) return delta > 0 ? sectionIdsValue[0] ?? null : sectionIdsValue.at(-1) ?? null;
  return sectionIdsValue[(index + delta + sectionIdsValue.length) % sectionIdsValue.length] ?? null;
};

export function resolveArcGisResultWorkspaceDetailAccessibilityKey(
  contract: ResultDetailAccessibilityContract,
  event: ResultDetailAccessibilityKeyEvent,
  currentTargetId?: string | null,
): ResultDetailAccessibilityKeyResolution {
  if (contract.hidden || suppress(event)) {
    return Object.freeze({ handled: false, preventDefault: false, focusTarget: null, action: 'none' });
  }
  if (event.key === 'Escape') {
    return Object.freeze({ handled: true, preventDefault: true, focusTarget: contract.restoreFocusTarget, action: 'close' });
  }
  if (event.key === 'Home') {
    const focusTarget = contract.sectionIds[0] ?? null;
    return Object.freeze({ handled: Boolean(focusTarget), preventDefault: Boolean(focusTarget), focusTarget, action: focusTarget ? 'first-section' : 'none' });
  }
  if (event.key === 'End') {
    const focusTarget = contract.sectionIds.at(-1) ?? null;
    return Object.freeze({ handled: Boolean(focusTarget), preventDefault: Boolean(focusTarget), focusTarget, action: focusTarget ? 'last-section' : 'none' });
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    const focusTarget = targetByDelta(contract.sectionIds, currentTargetId, 1);
    return Object.freeze({ handled: Boolean(focusTarget), preventDefault: Boolean(focusTarget), focusTarget, action: focusTarget ? 'next-section' : 'none' });
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    const focusTarget = targetByDelta(contract.sectionIds, currentTargetId, -1);
    return Object.freeze({ handled: Boolean(focusTarget), preventDefault: Boolean(focusTarget), focusTarget, action: focusTarget ? 'previous-section' : 'none' });
  }
  return Object.freeze({ handled: false, preventDefault: false, focusTarget: null, action: 'none' });
}
