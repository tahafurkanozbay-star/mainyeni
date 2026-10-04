import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

export type WorkspaceMapControl = 'results' | 'filters' | 'detail' | 'zoom-in' | 'zoom-out' | 'reset-view';
export type WorkspaceMapAnnouncementTone = 'polite' | 'assertive';

export interface WorkspaceMapAccessibilityInput {
  readonly scopeId?: string;
  readonly mapTitle?: string | null;
  readonly resultCount?: number;
  readonly selectedCount?: number;
  readonly activeResultLabel?: string | null;
  readonly mapReady?: boolean;
  readonly mapError?: string | null;
  readonly controls?: readonly WorkspaceMapControl[];
}

export interface WorkspaceMapControlContract {
  readonly id: string;
  readonly control: WorkspaceMapControl;
  readonly label: string;
  readonly disabled: boolean;
  readonly tabIndex: 0 | -1;
  readonly minimumTargetSize: 44 | 48;
}

export interface WorkspaceMapAccessibilityContract {
  readonly scopeId: string;
  readonly regionId: string;
  readonly headingId: string;
  readonly descriptionId: string;
  readonly statusId: string;
  readonly role: 'region';
  readonly label: string;
  readonly description: string;
  readonly statusMessage: string;
  readonly statusLive: WorkspaceMapAnnouncementTone;
  readonly busy: boolean;
  readonly controls: readonly WorkspaceMapControlContract[];
  readonly activeControl: WorkspaceMapControl | null;
  readonly focusVisible: boolean;
  readonly minimumTargetSize: 44 | 48;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly mapVisible: boolean;
  readonly revision: number;
}

export interface WorkspaceMapKeyEvent {
  readonly key: string;
  readonly editable?: boolean;
  readonly composing?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface WorkspaceMapKeyResolution {
  readonly handled: boolean;
  readonly preventDefault: boolean;
  readonly action: 'none' | 'focus-control' | 'invoke-control' | 'focus-map';
  readonly control: WorkspaceMapControl | null;
  readonly focusTarget: string | null;
}

const MAX_TEXT = 180;
const MAX_RESULT_COUNT = 20_000;
const DEFAULT_SCOPE = 'results-map';
const CONTROL_ORDER: readonly WorkspaceMapControl[] = Object.freeze([
  'results', 'filters', 'detail', 'zoom-in', 'zoom-out', 'reset-view',
]);

const CONTROL_LABELS: Readonly<Record<WorkspaceMapControl, string>> = Object.freeze({
  results: 'Sonuç listesine git',
  filters: 'Sonuç filtrelerini aç',
  detail: 'Seçili sonucun ayrıntılarını aç',
  'zoom-in': 'Haritayı yakınlaştır',
  'zoom-out': 'Haritayı uzaklaştır',
  'reset-view': 'Harita görünümünü sıfırla',
});

const boundedText = (value: unknown, max = MAX_TEXT): string => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const sanitizeId = (value: unknown, fallback: string): string => {
  const id = boundedText(value, 64)
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return id || fallback;
};

const boundedCount = (value: unknown, fallback = 0): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_RESULT_COUNT, Math.trunc(number)));
};

const normalizeControls = (values: readonly WorkspaceMapControl[] | undefined): readonly WorkspaceMapControl[] => {
  const admitted = new Set(values ?? CONTROL_ORDER);
  return Object.freeze(CONTROL_ORDER.filter((control) => admitted.has(control)));
};

const resultCountFrom = (snapshot: ResultWorkspaceSnapshot, explicit: number | undefined): number => {
  if (explicit !== undefined) return boundedCount(explicit);
  return boundedCount(snapshot.interaction.resultIds.length);
};

const selectedCountFrom = (snapshot: ResultWorkspaceSnapshot, explicit: number | undefined): number => {
  if (explicit !== undefined) return boundedCount(explicit);
  return boundedCount(snapshot.interaction.selectedIds.length);
};

const statusFor = (
  mapReady: boolean,
  mapError: string,
  resultCount: number,
  selectedCount: number,
  activeLabel: string,
): { readonly message: string; readonly live: WorkspaceMapAnnouncementTone; readonly busy: boolean } => {
  if (mapError) return { message: mapError, live: 'assertive', busy: false };
  if (!mapReady) return { message: 'Harita hazırlanıyor.', live: 'polite', busy: true };
  const resultText = resultCount === 1 ? '1 sonuç' : `${resultCount.toLocaleString('tr-TR')} sonuç`;
  const selectedText = selectedCount > 0 ? `, ${selectedCount.toLocaleString('tr-TR')} seçili` : '';
  const activeText = activeLabel ? `. Odaktaki sonuç: ${activeLabel}` : '';
  return { message: `Harita hazır: ${resultText}${selectedText}${activeText}.`, live: 'polite', busy: false };
};

const isControlDisabled = (
  control: WorkspaceMapControl,
  snapshot: ResultWorkspaceSnapshot,
  mapReady: boolean,
): boolean => {
  if ((control === 'zoom-in' || control === 'zoom-out' || control === 'reset-view') && !mapReady) return true;
  if (control === 'detail') return !snapshot.interaction.focusedId && !snapshot.interaction.activeId;
  if (control === 'filters') return snapshot.interaction.filterOpen;
  if (control === 'results') return snapshot.presentation.collectionVisible && snapshot.presentation.panel === 'collection';
  return false;
};

const firstEnabledControl = (controls: readonly WorkspaceMapControlContract[]): WorkspaceMapControl | null =>
  controls.find((control) => !control.disabled)?.control ?? null;

const controlId = (scopeId: string, control: WorkspaceMapControl): string => `${scopeId}-control-${control}`;

export const createArcGisResultWorkspaceMapAccessibilityContract = (
  snapshot: ResultWorkspaceSnapshot,
  input: WorkspaceMapAccessibilityInput = {},
  previous: WorkspaceMapAccessibilityContract | null = null,
): WorkspaceMapAccessibilityContract => {
  const scopeId = sanitizeId(input.scopeId, DEFAULT_SCOPE);
  const title = boundedText(input.mapTitle, 80) || snapshot.accessibility.mapLabel || 'Harita';
  const resultCount = resultCountFrom(snapshot, input.resultCount);
  const selectedCount = selectedCountFrom(snapshot, input.selectedCount);
  const activeLabel = boundedText(input.activeResultLabel, 80);
  const mapError = boundedText(input.mapError);
  const mapReady = input.mapReady !== false && !mapError;
  const status = statusFor(mapReady, mapError, resultCount, selectedCount, activeLabel);
  const admitted = normalizeControls(input.controls);

  const provisional = admitted.map((control): WorkspaceMapControlContract => Object.freeze({
    id: controlId(scopeId, control),
    control,
    label: CONTROL_LABELS[control],
    disabled: isControlDisabled(control, snapshot, mapReady),
    tabIndex: -1,
    minimumTargetSize: snapshot.accessibility.minimumTargetSize,
  }));
  const previousActive = previous?.activeControl ?? null;
  const activeStillEnabled = previousActive && provisional.some((control) => control.control === previousActive && !control.disabled)
    ? previousActive
    : null;
  const activeControl = activeStillEnabled ?? firstEnabledControl(provisional);
  const controls = Object.freeze(provisional.map((control) => Object.freeze({
    ...control,
    tabIndex: control.control === activeControl ? 0 as const : -1 as const,
  })));

  const description = snapshot.presentation.splitView
    ? 'Harita ve sonuç listesi birlikte görünür. Harita kontrolleri arasında ok tuşlarıyla ilerleyebilirsiniz.'
    : snapshot.presentation.mapVisible
      ? 'Harita görünümü etkin. Sonuçlara, filtrelere ve harita kontrollerine klavyeyle erişebilirsiniz.'
      : 'Harita şu anda gizli. Haritayı göster komutuyla harita görünümüne geçebilirsiniz.';
  const changed = !previous
    || previous.statusMessage !== status.message
    || previous.mapVisible !== snapshot.presentation.mapVisible
    || previous.activeControl !== activeControl
    || previous.controls.some((control, index) => {
      const next = controls[index];
      return !next || next.control !== control.control || next.disabled !== control.disabled;
    })
    || previous.controls.length !== controls.length;
  const revision = changed ? (previous?.revision ?? -1) + 1 : (previous?.revision ?? 0);

  return Object.freeze({
    scopeId,
    regionId: `${scopeId}-region`,
    headingId: `${scopeId}-heading`,
    descriptionId: `${scopeId}-description`,
    statusId: `${scopeId}-status`,
    role: 'region',
    label: boundedText(title, 80),
    description: boundedText(description),
    statusMessage: boundedText(status.message),
    statusLive: status.live,
    busy: status.busy,
    controls,
    activeControl,
    focusVisible: snapshot.modality === 'keyboard',
    minimumTargetSize: snapshot.accessibility.minimumTargetSize,
    reducedMotion: snapshot.accessibility.reducedMotion,
    forcedColors: snapshot.accessibility.forcedColors,
    mapVisible: snapshot.presentation.mapVisible,
    revision,
  });
};

const ignoredKeyContext = (event: WorkspaceMapKeyEvent): boolean => Boolean(
  event.editable || event.composing || event.repeat || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey,
);

const enabledControls = (contract: WorkspaceMapAccessibilityContract): readonly WorkspaceMapControlContract[] =>
  contract.controls.filter((control) => !control.disabled);

const moveControl = (
  contract: WorkspaceMapAccessibilityContract,
  direction: -1 | 1,
  boundary: 'none' | 'start' | 'end' = 'none',
): WorkspaceMapControlContract | null => {
  const enabled = enabledControls(contract);
  if (enabled.length === 0) return null;
  if (boundary === 'start') return enabled[0] ?? null;
  if (boundary === 'end') return enabled[enabled.length - 1] ?? null;
  const currentIndex = enabled.findIndex((control) => control.control === contract.activeControl);
  const base = currentIndex >= 0 ? currentIndex : 0;
  return enabled[(base + direction + enabled.length) % enabled.length] ?? null;
};

export const resolveArcGisResultWorkspaceMapAccessibilityKey = (
  contract: WorkspaceMapAccessibilityContract,
  event: WorkspaceMapKeyEvent,
): WorkspaceMapKeyResolution => {
  const none: WorkspaceMapKeyResolution = Object.freeze({
    handled: false, preventDefault: false, action: 'none', control: null, focusTarget: null,
  });
  if (ignoredKeyContext(event)) return none;

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    const direction: -1 | 1 = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const target = moveControl(contract, direction);
    if (!target) return none;
    return Object.freeze({ handled: true, preventDefault: true, action: 'focus-control', control: target.control, focusTarget: target.id });
  }
  if (event.key === 'Home' || event.key === 'End') {
    const target = moveControl(contract, 1, event.key === 'Home' ? 'start' : 'end');
    if (!target) return none;
    return Object.freeze({ handled: true, preventDefault: true, action: 'focus-control', control: target.control, focusTarget: target.id });
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const target = contract.controls.find((control) => control.control === contract.activeControl && !control.disabled) ?? null;
    if (!target) return none;
    return Object.freeze({ handled: true, preventDefault: true, action: 'invoke-control', control: target.control, focusTarget: target.id });
  }
  if (event.key === 'Escape') {
    return Object.freeze({ handled: true, preventDefault: true, action: 'focus-map', control: null, focusTarget: contract.regionId });
  }
  return none;
};
