import type { WorkspaceFocusZone, WorkspaceInputModality } from './workspaceAccessibilityModel';

export type WorkspaceFocusReason = 'dialog-close' | 'palette-close' | 'surface-removed' | 'route-change' | 'escape' | 'landmark-cycle';

export interface WorkspaceFocusTarget {
  readonly zone: WorkspaceFocusZone;
  readonly selector: string;
  readonly fallbackSelector: string | null;
  readonly preventScroll: boolean;
}

export interface WorkspaceFocusRecoveryRequest {
  readonly reason: WorkspaceFocusReason;
  readonly preferredZone: WorkspaceFocusZone;
  readonly originZone: WorkspaceFocusZone;
  readonly modality: WorkspaceInputModality;
  readonly availableZones: readonly WorkspaceFocusZone[];
  readonly dialogDepth: number;
  readonly paletteOpen: boolean;
}

export interface WorkspaceFocusRecoveryDecision {
  readonly target: WorkspaceFocusTarget | null;
  readonly shouldRestore: boolean;
  readonly shouldShowFocusRing: boolean;
  readonly reason: WorkspaceFocusReason;
}

const selectors: Readonly<Record<WorkspaceFocusZone, WorkspaceFocusTarget | null>> = Object.freeze({
  map: Object.freeze({ zone: 'map', selector: '#esri-map-container', fallbackSelector: 'main', preventScroll: true }),
  tools: Object.freeze({ zone: 'tools', selector: '#sidebar', fallbackSelector: '#experience-workspace-controls', preventScroll: true }),
  workspace: Object.freeze({ zone: 'workspace', selector: '#experience-workspace-controls', fallbackSelector: 'main', preventScroll: true }),
  dialog: Object.freeze({ zone: 'dialog', selector: '[role="dialog"]', fallbackSelector: null, preventScroll: true }),
  'command-palette': Object.freeze({ zone: 'command-palette', selector: '[data-experience-command-palette]', fallbackSelector: '#experience-workspace-controls', preventScroll: true }),
  unknown: null,
});

const uniqueZones = (zones: readonly WorkspaceFocusZone[]): readonly WorkspaceFocusZone[] => Object.freeze([...new Set(zones.filter((zone) => zone !== 'unknown'))].slice(0, 8));

export const workspaceFocusTargetForZone = (zone: WorkspaceFocusZone): WorkspaceFocusTarget | null => selectors[zone];

export const resolveWorkspaceFocusRecovery = (request: WorkspaceFocusRecoveryRequest): WorkspaceFocusRecoveryDecision => {
  const available = uniqueZones(request.availableZones);
  const has = (zone: WorkspaceFocusZone): boolean => available.includes(zone);
  const focusRing = request.modality === 'keyboard';

  if (request.dialogDepth > 0 && has('dialog')) return Object.freeze({ target: selectors.dialog, shouldRestore: true, shouldShowFocusRing: focusRing, reason: request.reason });
  if (request.paletteOpen && has('command-palette')) return Object.freeze({ target: selectors['command-palette'], shouldRestore: true, shouldShowFocusRing: focusRing, reason: request.reason });

  const candidates: readonly WorkspaceFocusZone[] = Object.freeze([
    request.preferredZone,
    request.originZone,
    'workspace',
    'tools',
    'map',
  ]);
  const zone = candidates.find((candidate) => candidate !== 'unknown' && has(candidate)) ?? null;
  const target = zone ? selectors[zone] : null;
  return Object.freeze({ target, shouldRestore: target !== null, shouldShowFocusRing: focusRing && target !== null, reason: request.reason });
};

export const resolveWorkspaceEscapeTarget = (input: Omit<WorkspaceFocusRecoveryRequest, 'reason'>): WorkspaceFocusRecoveryDecision => resolveWorkspaceFocusRecovery({ ...input, reason: 'escape', preferredZone: input.dialogDepth > 0 ? 'dialog' : input.paletteOpen ? 'command-palette' : input.preferredZone });

export const workspaceLandmarkOrder = (availableZones: readonly WorkspaceFocusZone[]): readonly WorkspaceFocusZone[] => {
  const available = uniqueZones(availableZones);
  const canonical: readonly WorkspaceFocusZone[] = Object.freeze(['workspace', 'tools', 'map']);
  return Object.freeze(canonical.filter((zone) => available.includes(zone)));
};

export const cycleWorkspaceLandmark = (current: WorkspaceFocusZone, availableZones: readonly WorkspaceFocusZone[], reverse = false): WorkspaceFocusZone | null => {
  const order = workspaceLandmarkOrder(availableZones);
  if (order.length === 0) return null;
  const index = order.indexOf(current);
  if (index < 0) return reverse ? order[order.length - 1] ?? null : order[0] ?? null;
  const offset = reverse ? -1 : 1;
  return order[(index + offset + order.length) % order.length] ?? null;
};

export const shouldRecoverWorkspaceFocus = (input: { readonly activeElementConnected: boolean; readonly bodyHasFocus: boolean; readonly modalOpen: boolean; readonly paletteOpen: boolean }): boolean => !input.activeElementConnected || input.bodyHasFocus || input.modalOpen || input.paletteOpen;

export const workspaceFocusRecoveryLabel = (decision: WorkspaceFocusRecoveryDecision): string => {
  if (!decision.target) return 'Odak geri yüklenemedi';
  const labels: Readonly<Record<Exclude<WorkspaceFocusZone, 'unknown'>, string>> = Object.freeze({ map: 'Haritaya dön', tools: 'Araçlara dön', workspace: 'Çalışma alanına dön', dialog: 'İletişim penceresine dön', 'command-palette': 'Komut paletine dön' });
  return decision.target.zone === 'unknown' ? 'Odak geri yüklenemedi' : labels[decision.target.zone];
};
