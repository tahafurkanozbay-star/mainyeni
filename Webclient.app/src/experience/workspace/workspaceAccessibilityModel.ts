export type WorkspaceInputModality = 'keyboard' | 'pointer' | 'touch' | 'unknown';
export type WorkspaceFocusZone = 'map' | 'tools' | 'workspace' | 'dialog' | 'command-palette' | 'unknown';
export type WorkspaceAnnouncementPriority = 'polite' | 'assertive';

export interface WorkspaceAccessibilitySnapshot {
  readonly modality: WorkspaceInputModality;
  readonly focusZone: WorkspaceFocusZone;
  readonly previousFocusZone: WorkspaceFocusZone;
  readonly dialogDepth: number;
  readonly commandPaletteOpen: boolean;
  readonly mapBusy: boolean;
  readonly online: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly sequence: number;
}

export interface WorkspaceAccessibilityTransition {
  readonly state: WorkspaceAccessibilitySnapshot;
  readonly announcement: string | null;
  readonly priority: WorkspaceAnnouncementPriority;
  readonly restoreFocusTo: WorkspaceFocusZone | null;
}

const initialSnapshot = (): WorkspaceAccessibilitySnapshot => Object.freeze({
  modality: 'unknown',
  focusZone: 'unknown',
  previousFocusZone: 'unknown',
  dialogDepth: 0,
  commandPaletteOpen: false,
  mapBusy: false,
  online: true,
  reducedMotion: false,
  forcedColors: false,
  sequence: 0,
});

const next = (
  state: WorkspaceAccessibilitySnapshot,
  patch: Partial<WorkspaceAccessibilitySnapshot>,
): WorkspaceAccessibilitySnapshot => Object.freeze({
  ...state,
  ...patch,
  sequence: state.sequence + 1,
});

export const createWorkspaceAccessibilityState = (
  seed: Partial<Omit<WorkspaceAccessibilitySnapshot, 'sequence'>> = {},
): WorkspaceAccessibilitySnapshot => Object.freeze({
  ...initialSnapshot(),
  ...seed,
  dialogDepth: Math.max(0, Math.trunc(seed.dialogDepth ?? 0)),
});

export const setWorkspaceInputModality = (
  state: WorkspaceAccessibilitySnapshot,
  modality: WorkspaceInputModality,
): WorkspaceAccessibilityTransition => ({
  state: state.modality === modality ? state : next(state, { modality }),
  announcement: null,
  priority: 'polite',
  restoreFocusTo: null,
});

export const enterWorkspaceFocusZone = (
  state: WorkspaceAccessibilitySnapshot,
  focusZone: WorkspaceFocusZone,
): WorkspaceAccessibilityTransition => {
  if (state.focusZone === focusZone) {
    return { state, announcement: null, priority: 'polite', restoreFocusTo: null };
  }
  return {
    state: next(state, { previousFocusZone: state.focusZone, focusZone }),
    announcement: null,
    priority: 'polite',
    restoreFocusTo: null,
  };
};

export const openWorkspaceDialog = (
  state: WorkspaceAccessibilitySnapshot,
): WorkspaceAccessibilityTransition => ({
  state: next(state, {
    previousFocusZone: state.focusZone,
    focusZone: 'dialog',
    dialogDepth: state.dialogDepth + 1,
  }),
  announcement: state.dialogDepth === 0 ? 'İletişim penceresi açıldı.' : null,
  priority: 'polite',
  restoreFocusTo: null,
});

export const closeWorkspaceDialog = (
  state: WorkspaceAccessibilitySnapshot,
): WorkspaceAccessibilityTransition => {
  if (state.dialogDepth <= 0) {
    return { state, announcement: null, priority: 'polite', restoreFocusTo: null };
  }
  const dialogDepth = state.dialogDepth - 1;
  const restoreFocusTo = dialogDepth === 0 && state.previousFocusZone !== 'dialog'
    ? state.previousFocusZone
    : null;
  return {
    state: next(state, {
      dialogDepth,
      focusZone: dialogDepth > 0 ? 'dialog' : (restoreFocusTo ?? 'workspace'),
    }),
    announcement: dialogDepth === 0 ? 'İletişim penceresi kapatıldı.' : null,
    priority: 'polite',
    restoreFocusTo,
  };
};

export const setCommandPaletteOpen = (
  state: WorkspaceAccessibilitySnapshot,
  open: boolean,
): WorkspaceAccessibilityTransition => {
  if (state.commandPaletteOpen === open) {
    return { state, announcement: null, priority: 'polite', restoreFocusTo: null };
  }
  if (open) {
    return {
      state: next(state, {
        commandPaletteOpen: true,
        previousFocusZone: state.focusZone,
        focusZone: 'command-palette',
      }),
      announcement: 'Komut paleti açıldı.',
      priority: 'polite',
      restoreFocusTo: null,
    };
  }
  const restoreFocusTo = state.previousFocusZone === 'command-palette'
    ? 'workspace'
    : state.previousFocusZone;
  return {
    state: next(state, {
      commandPaletteOpen: false,
      focusZone: restoreFocusTo,
    }),
    announcement: 'Komut paleti kapatıldı.',
    priority: 'polite',
    restoreFocusTo,
  };
};

export const setWorkspaceMapBusy = (
  state: WorkspaceAccessibilitySnapshot,
  busy: boolean,
): WorkspaceAccessibilityTransition => {
  if (state.mapBusy === busy) {
    return { state, announcement: null, priority: 'polite', restoreFocusTo: null };
  }
  return {
    state: next(state, { mapBusy: busy }),
    announcement: busy ? 'Harita güncelleniyor.' : 'Harita güncellemesi tamamlandı.',
    priority: 'polite',
    restoreFocusTo: null,
  };
};

export const setWorkspaceConnectivity = (
  state: WorkspaceAccessibilitySnapshot,
  online: boolean,
): WorkspaceAccessibilityTransition => {
  if (state.online === online) {
    return { state, announcement: null, priority: 'polite', restoreFocusTo: null };
  }
  return {
    state: next(state, { online }),
    announcement: online
      ? 'Bağlantı yeniden kuruldu.'
      : 'Bağlantı kesildi. Haritadaki bazı bilgiler güncel olmayabilir.',
    priority: online ? 'polite' : 'assertive',
    restoreFocusTo: null,
  };
};

export const setWorkspaceMediaAccessibility = (
  state: WorkspaceAccessibilitySnapshot,
  input: { readonly reducedMotion: boolean; readonly forcedColors: boolean },
): WorkspaceAccessibilityTransition => {
  if (state.reducedMotion === input.reducedMotion && state.forcedColors === input.forcedColors) {
    return { state, announcement: null, priority: 'polite', restoreFocusTo: null };
  }
  return {
    state: next(state, input),
    announcement: null,
    priority: 'polite',
    restoreFocusTo: null,
  };
};

export const workspaceFocusSelector = (zone: WorkspaceFocusZone): string | null => {
  switch (zone) {
    case 'map': return '#esri-map-container';
    case 'tools': return '#sidebar';
    case 'workspace': return '#experience-workspace-controls';
    case 'command-palette': return '[data-experience-command-palette]';
    case 'dialog': return '[role="dialog"]';
    default: return null;
  }
};

export const workspaceAccessibilitySummary = (
  state: WorkspaceAccessibilitySnapshot,
): readonly string[] => Object.freeze([
  state.online ? 'Çevrimiçi' : 'Çevrimdışı',
  state.mapBusy ? 'Harita güncelleniyor' : 'Harita hazır',
  state.reducedMotion ? 'Azaltılmış hareket' : 'Standart hareket',
  state.forcedColors ? 'Zorunlu renkler etkin' : 'Standart renkler',
  state.modality === 'keyboard' ? 'Klavye kullanımı' : state.modality === 'touch' ? 'Dokunmatik kullanım' : 'İşaretçi kullanımı',
]);
