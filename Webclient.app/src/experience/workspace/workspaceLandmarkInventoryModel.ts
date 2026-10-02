import type { WorkspaceFocusZone } from './workspaceAccessibilityModel';

export type WorkspaceLandmarkId =
  | 'map'
  | 'navigation'
  | 'search'
  | 'sidebar'
  | 'toolbar'
  | 'workspace'
  | 'help'
  | 'dialog'
  | 'command-palette';

export type WorkspaceLandmarkHealth = 'ready' | 'degraded' | 'critical';
export type WorkspaceLandmarkStatus = 'ready' | 'hidden' | 'unlabelled' | 'unfocusable' | 'disabled' | 'missing';

export interface WorkspaceLandmarkDefinition {
  readonly id: WorkspaceLandmarkId;
  readonly selector: string;
  readonly label: string;
  readonly required: boolean;
  readonly focusZone: WorkspaceFocusZone;
  readonly order: number;
}

export interface WorkspaceLandmarkObservation {
  readonly id: WorkspaceLandmarkId;
  readonly present: boolean;
  readonly visible: boolean;
  readonly focusable: boolean;
  readonly labelled: boolean;
  readonly disabled: boolean;
}

export interface WorkspaceLandmarkEntry extends WorkspaceLandmarkObservation {
  readonly label: string;
  readonly required: boolean;
  readonly focusZone: WorkspaceFocusZone;
  readonly order: number;
  readonly status: WorkspaceLandmarkStatus;
  readonly usable: boolean;
}

export interface WorkspaceLandmarkInventorySnapshot {
  readonly revision: number;
  readonly health: WorkspaceLandmarkHealth;
  readonly totalCount: number;
  readonly readyCount: number;
  readonly degradedCount: number;
  readonly missingRequiredCount: number;
  readonly availableFocusZones: readonly WorkspaceFocusZone[];
  readonly entries: readonly WorkspaceLandmarkEntry[];
  readonly announcement: string;
}

export interface WorkspaceLandmarkInventoryOptions {
  readonly requiredIds?: readonly WorkspaceLandmarkId[];
}

const MAX_LANDMARKS = 16;

const DEFINITION_INPUT = [
  { id: 'map', selector: '#esri-map-container,[data-workspace-map]', label: 'Harita', required: true, focusZone: 'map', order: 10 },
  { id: 'navigation', selector: '#mainbar,[data-workspace-navigation]', label: 'Üst gezinme', required: true, focusZone: 'workspace', order: 20 },
  { id: 'search', selector: '#kentrehberi-global-search,[data-workspace-search]', label: 'Genel arama', required: true, focusZone: 'workspace', order: 30 },
  { id: 'sidebar', selector: '#sidebar,[data-workspace-tools]', label: 'Katman ve hizmet menüsü', required: true, focusZone: 'tools', order: 40 },
  { id: 'toolbar', selector: '#toolbar-widget,[data-workspace-toolbar]', label: 'Harita araçları', required: true, focusZone: 'tools', order: 50 },
  { id: 'workspace', selector: '#experience-workspace-controls,[data-workspace-shell]', label: 'Çalışma alanı kontrolleri', required: true, focusZone: 'workspace', order: 60 },
  { id: 'help', selector: '[data-workspace-help],.map-shortcut-help__launcher', label: 'Çalışma alanı yardımı', required: false, focusZone: 'workspace', order: 70 },
  { id: 'dialog', selector: '[role="dialog"],[aria-modal="true"]', label: 'İletişim penceresi', required: false, focusZone: 'dialog', order: 80 },
  { id: 'command-palette', selector: '[data-experience-command-palette]', label: 'Komut paleti', required: false, focusZone: 'command-palette', order: 90 },
] as const satisfies readonly WorkspaceLandmarkDefinition[];

export const WORKSPACE_LANDMARK_DEFINITIONS: readonly WorkspaceLandmarkDefinition[] = Object.freeze(
  DEFINITION_INPUT.map((definition) => Object.freeze({ ...definition })),
);

const DEFAULT_OBSERVATION: Readonly<WorkspaceLandmarkObservation> = Object.freeze({
  id: 'workspace',
  present: false,
  visible: false,
  focusable: false,
  labelled: false,
  disabled: false,
});

const uniqueBoundedIds = (ids: readonly WorkspaceLandmarkId[]): readonly WorkspaceLandmarkId[] => {
  const seen = new Set<WorkspaceLandmarkId>();
  const result: WorkspaceLandmarkId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_LANDMARKS) break;
  }
  return Object.freeze(result);
};

const normalizeObservation = (
  id: WorkspaceLandmarkId,
  observation: WorkspaceLandmarkObservation | undefined,
): WorkspaceLandmarkObservation => Object.freeze({
  ...DEFAULT_OBSERVATION,
  id,
  present: observation?.present === true,
  visible: observation?.visible === true,
  focusable: observation?.focusable === true,
  labelled: observation?.labelled === true,
  disabled: observation?.disabled === true,
});

export const workspaceLandmarkStatus = (observation: WorkspaceLandmarkObservation): WorkspaceLandmarkStatus => {
  if (!observation.present) return 'missing';
  if (!observation.visible) return 'hidden';
  if (observation.disabled) return 'disabled';
  if (!observation.labelled) return 'unlabelled';
  if (!observation.focusable) return 'unfocusable';
  return 'ready';
};

const buildEntry = (
  definition: WorkspaceLandmarkDefinition,
  observation: WorkspaceLandmarkObservation | undefined,
  requiredOverride: ReadonlySet<WorkspaceLandmarkId> | null,
): WorkspaceLandmarkEntry => {
  const normalized = normalizeObservation(definition.id, observation);
  const status = workspaceLandmarkStatus(normalized);
  const required = requiredOverride ? requiredOverride.has(definition.id) : definition.required;
  return Object.freeze({
    ...normalized,
    label: definition.label,
    required,
    focusZone: definition.focusZone,
    order: definition.order,
    status,
    usable: status === 'ready',
  });
};

const healthForEntries = (entries: readonly WorkspaceLandmarkEntry[]): WorkspaceLandmarkHealth => {
  if (entries.some((entry) => entry.required && (entry.status === 'missing' || entry.status === 'hidden'))) return 'critical';
  if (entries.some((entry) => entry.required && entry.status !== 'ready')) return 'degraded';
  if (entries.some((entry) => !entry.required && entry.present && entry.status !== 'ready')) return 'degraded';
  return 'ready';
};

const announcementForInventory = (
  health: WorkspaceLandmarkHealth,
  readyCount: number,
  totalCount: number,
  missingRequiredCount: number,
): string => {
  if (health === 'ready') return `${readyCount} çalışma alanı hedefi kullanıma hazır.`;
  if (health === 'critical') return `${missingRequiredCount} zorunlu çalışma alanı hedefi kullanılamıyor.`;
  return `Çalışma alanında ${readyCount}/${totalCount} erişilebilir hedef hazır.`;
};

const availableZonesForEntries = (entries: readonly WorkspaceLandmarkEntry[]): readonly WorkspaceFocusZone[] => {
  const zones: WorkspaceFocusZone[] = [];
  const seen = new Set<WorkspaceFocusZone>();
  for (const entry of entries) {
    if (!entry.usable || entry.focusZone === 'unknown' || seen.has(entry.focusZone)) continue;
    seen.add(entry.focusZone);
    zones.push(entry.focusZone);
  }
  return Object.freeze(zones);
};

export const createWorkspaceLandmarkInventory = (
  observations: readonly WorkspaceLandmarkObservation[],
  options: WorkspaceLandmarkInventoryOptions = {},
  revision = 0,
): WorkspaceLandmarkInventorySnapshot => {
  const observationMap = new Map<WorkspaceLandmarkId, WorkspaceLandmarkObservation>();
  for (const observation of observations.slice(0, MAX_LANDMARKS)) observationMap.set(observation.id, observation);

  const requiredIds = options.requiredIds ? new Set(uniqueBoundedIds(options.requiredIds)) : null;
  const entries = Object.freeze(
    WORKSPACE_LANDMARK_DEFINITIONS
      .map((definition) => buildEntry(definition, observationMap.get(definition.id), requiredIds))
      .sort((left, right) => left.order - right.order),
  );
  const health = healthForEntries(entries);
  const readyCount = entries.filter((entry) => entry.status === 'ready').length;
  const missingRequiredCount = entries.filter((entry) => entry.required && (entry.status === 'missing' || entry.status === 'hidden')).length;
  const degradedCount = entries.filter((entry) => entry.status !== 'ready').length;

  return Object.freeze({
    revision: Math.max(0, Math.trunc(Number.isFinite(revision) ? revision : 0)),
    health,
    totalCount: entries.length,
    readyCount,
    degradedCount,
    missingRequiredCount,
    availableFocusZones: availableZonesForEntries(entries),
    entries,
    announcement: announcementForInventory(health, readyCount, entries.length, missingRequiredCount),
  });
};

export const workspaceLandmarkEntry = (
  snapshot: WorkspaceLandmarkInventorySnapshot,
  id: WorkspaceLandmarkId,
): WorkspaceLandmarkEntry | null => snapshot.entries.find((entry) => entry.id === id) ?? null;

export const workspaceLandmarkUsableIds = (snapshot: WorkspaceLandmarkInventorySnapshot): readonly WorkspaceLandmarkId[] => Object.freeze(
  snapshot.entries.filter((entry) => entry.usable).map((entry) => entry.id),
);

export const workspaceLandmarkRequiredFailures = (snapshot: WorkspaceLandmarkInventorySnapshot): readonly WorkspaceLandmarkEntry[] => Object.freeze(
  snapshot.entries.filter((entry) => entry.required && entry.status !== 'ready'),
);

export const workspaceLandmarkInventoryChanged = (
  previous: WorkspaceLandmarkInventorySnapshot,
  next: WorkspaceLandmarkInventorySnapshot,
): boolean => {
  if (previous.health !== next.health || previous.entries.length !== next.entries.length) return true;
  return previous.entries.some((entry, index) => {
    const candidate = next.entries[index];
    return !candidate
      || candidate.id !== entry.id
      || candidate.status !== entry.status
      || candidate.required !== entry.required;
  });
};
