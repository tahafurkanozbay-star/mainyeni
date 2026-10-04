import type { ResultWorkspaceAccessibilityContract } from './ArcGisResultWorkspaceAccessibilityExperiencePolicy';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import type {
  WorkspaceFilterFieldContract,
  WorkspaceFilterFocusTarget,
  WorkspaceFilterSnapshot,
  WorkspaceFilterTransition,
} from './ArcGisResultWorkspaceFilterExperiencePolicy';

export type WorkspaceFilterAccessibilityReason =
  | 'stable'
  | 'panel-opened'
  | 'panel-closed'
  | 'validation-error'
  | 'validation-cleared'
  | 'draft-changed'
  | 'applied'
  | 'cancelled'
  | 'viewport-reconciled';

export interface WorkspaceFilterAccessibilityField {
  readonly id: string;
  readonly clauseId: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly ariaInvalid: boolean;
  readonly ariaDescribedBy?: string;
  readonly errorId?: string;
  readonly errorMessage: string;
  readonly touchTargetPx: number;
}

export interface WorkspaceFilterAccessibilityContract {
  readonly panelId: string;
  readonly triggerId: string;
  readonly role: 'region' | 'dialog';
  readonly modal: boolean;
  readonly hidden: boolean;
  readonly labelledBy: string;
  readonly describedBy: string;
  readonly statusId: string;
  readonly hintId: string;
  readonly focusTarget: WorkspaceFilterFocusTarget;
  readonly focusTargetId: string | null;
  readonly restoreFocusId: string | null;
  readonly firstInvalidId: string | null;
  readonly invalidCount: number;
  readonly dirty: boolean;
  readonly canApply: boolean;
  readonly canClear: boolean;
  readonly fields: readonly WorkspaceFilterAccessibilityField[];
  readonly liveRegion: Readonly<{
    role: 'status' | 'alert';
    ariaLive: 'polite' | 'assertive';
    ariaAtomic: true;
    message: string;
  }>;
  readonly keyboardHint: string;
  readonly minimumTargetSize: 44 | 48;
  readonly focusVisible: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly reason: WorkspaceFilterAccessibilityReason;
  readonly revision: number;
}

const MAX_TEXT = 240;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

const cleanText = (value: unknown, maximum = MAX_TEXT): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

const nextRevision = (revision: number): number => {
  const safe = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  return safe >= MAX_REVISION ? 0 : safe + 1;
};

const errorForField = (snapshot: WorkspaceFilterSnapshot, field: WorkspaceFilterFieldContract): string => {
  if (!field.invalid) return '';
  const definition = snapshot.state.definitions.find((candidate) => candidate.id === field.filterId);
  if (!definition) return 'Filtre değerini kontrol edin.';
  if (definition.kind === 'number') return 'Geçerli bir sayı girin.';
  if (definition.kind === 'date') return 'Geçerli bir tarih girin.';
  if (definition.kind === 'choice') return 'Listeden geçerli bir seçenek belirleyin.';
  return 'Filtre değerini kontrol edin.';
};

const createFields = (snapshot: WorkspaceFilterSnapshot): readonly WorkspaceFilterAccessibilityField[] => Object.freeze(
  snapshot.fields.map((field) => Object.freeze({
    id: field.id,
    clauseId: field.clauseId,
    label: cleanText(field.label, 160),
    invalid: field.invalid,
    ariaInvalid: field.invalid,
    ...(field.describedBy ? { ariaDescribedBy: field.describedBy } : {}),
    ...(field.errorId ? { errorId: field.errorId } : {}),
    errorMessage: errorForField(snapshot, field),
    touchTargetPx: field.touchTargetPx,
  })),
);

const inferReason = (
  previous: WorkspaceFilterAccessibilityContract | null,
  snapshot: WorkspaceFilterSnapshot,
  transition?: WorkspaceFilterTransition,
): WorkspaceFilterAccessibilityReason => {
  if (transition?.dismissReason === 'apply') return 'applied';
  if (transition?.dismissReason === 'cancel' || transition?.dismissReason === 'escape') return 'cancelled';
  if (transition?.dismissReason === 'viewport-change') return 'viewport-reconciled';
  if (!previous) return snapshot.state.panelOpen ? 'panel-opened' : 'stable';
  if (previous.hidden && !snapshot.panel.hidden) return 'panel-opened';
  if (!previous.hidden && snapshot.panel.hidden) return 'panel-closed';
  if (previous.invalidCount === 0 && snapshot.state.invalidClauseIds.length > 0) return 'validation-error';
  if (previous.invalidCount > 0 && snapshot.state.invalidClauseIds.length === 0) return 'validation-cleared';
  if (previous.dirty !== snapshot.dirty) return 'draft-changed';
  return 'stable';
};

const messageFor = (
  reason: WorkspaceFilterAccessibilityReason,
  snapshot: WorkspaceFilterSnapshot,
  transition?: WorkspaceFilterTransition,
): string => {
  const upstream = cleanText(transition?.announcement ?? snapshot.live.message);
  if (upstream) return upstream;
  const invalidCount = snapshot.state.invalidClauseIds.length;
  if (reason === 'panel-opened') return 'Sonuç filtreleri açıldı.';
  if (reason === 'panel-closed') return 'Sonuç filtreleri kapatıldı.';
  if (reason === 'validation-error') return `${invalidCount} filtre alanında hata var.`;
  if (reason === 'validation-cleared') return 'Filtre hataları giderildi.';
  if (reason === 'applied') return 'Filtreler uygulandı.';
  if (reason === 'cancelled') return 'Filtre değişiklikleri iptal edildi.';
  return '';
};

const firstInvalidId = (snapshot: WorkspaceFilterSnapshot): string | null =>
  snapshot.fields.find((field) => field.invalid)?.id ?? null;

/**
 * Bridges the filter interaction authority with the workspace accessibility
 * contract. The filter state remains owned by WorkspaceFilterExperiencePolicy;
 * this module only derives semantic DOM/focus/live-region facts.
 */
export function createArcGisResultWorkspaceFilterAccessibilityContract(
  workspace: ResultWorkspaceSnapshot,
  workspaceAccessibility: ResultWorkspaceAccessibilityContract,
  snapshot: WorkspaceFilterSnapshot,
  previous: WorkspaceFilterAccessibilityContract | null = null,
  transition?: WorkspaceFilterTransition,
): WorkspaceFilterAccessibilityContract {
  const reason = inferReason(previous, snapshot, transition);
  const invalidCount = snapshot.state.invalidClauseIds.length;
  const message = messageFor(reason, snapshot, transition);
  const statusId = `${snapshot.panel.id}-status`;
  const hintId = `${snapshot.panel.id}-hint`;
  const focusTargetId = transition?.focusTargetId ?? snapshot.focusTargetId ?? null;
  const overlay = snapshot.panel.role === 'dialog';
  const keyboardHint = overlay
    ? 'Sekme tuşuyla filtre alanlarında ilerleyin. Escape ile değişiklikleri iptal edip sonuçlara dönün.'
    : 'Sekme tuşuyla filtre alanlarında ilerleyin. Uygula ile sonuçları güncelleyin.';
  const assertive = invalidCount > 0 && (reason === 'validation-error' || snapshot.live.role === 'alert');
  const restoreFocusId = snapshot.panel.restoreFocusOnClose
    ? snapshot.trigger.id
    : workspaceAccessibility.activeDescendant ?? workspaceAccessibility.ids.collection;

  return Object.freeze({
    panelId: snapshot.panel.id,
    triggerId: snapshot.trigger.id,
    role: snapshot.panel.role,
    modal: snapshot.panel.modal,
    hidden: snapshot.panel.hidden,
    labelledBy: workspaceAccessibility.ids.filtersHeading,
    describedBy: `${statusId} ${hintId}`,
    statusId,
    hintId,
    focusTarget: transition?.focusTarget ?? snapshot.focusTarget,
    focusTargetId,
    restoreFocusId,
    firstInvalidId: firstInvalidId(snapshot),
    invalidCount,
    dirty: snapshot.dirty,
    canApply: snapshot.canApply,
    canClear: snapshot.canClear,
    fields: createFields(snapshot),
    liveRegion: Object.freeze({
      role: assertive ? 'alert' : 'status',
      ariaLive: assertive ? 'assertive' : 'polite',
      ariaAtomic: true,
      message,
    }),
    keyboardHint,
    minimumTargetSize: workspace.accessibility.minimumTargetSize,
    focusVisible: workspace.modality === 'keyboard',
    reducedMotion: workspace.accessibility.reducedMotion,
    forcedColors: workspace.accessibility.forcedColors,
    reason,
    revision: previous ? nextRevision(previous.revision) : 0,
  });
}

export function resolveArcGisResultWorkspaceFilterAccessibilityFocus(
  contract: WorkspaceFilterAccessibilityContract,
): string | null {
  if (contract.hidden) return contract.restoreFocusId;
  if (contract.invalidCount > 0 && contract.firstInvalidId) return contract.firstInvalidId;
  return contract.focusTargetId ?? contract.panelId;
}

export function shouldTrapArcGisResultWorkspaceFilterFocus(
  snapshot: WorkspaceFilterSnapshot,
): boolean {
  return snapshot.panel.role === 'dialog' && snapshot.panel.modal && !snapshot.panel.hidden;
}
