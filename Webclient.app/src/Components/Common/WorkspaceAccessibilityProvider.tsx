import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  WorkspaceAccessibilityRuntime,
  type WorkspaceAccessibilityRuntimeSnapshot,
} from '../../experience/workspace/workspaceAccessibilityRuntime';
import {
  createWorkspaceAccessibilityPreferenceSession,
  createWorkspaceAccessibilityPreferenceStorage,
  type WorkspaceAccessibilityPreferencePatch,
  type WorkspaceAccessibilityPreferences,
} from '../../experience/workspace/workspaceAccessibilityPreferencesModel';
import {
  createWorkspaceAccessibilityStatusSnapshot,
  type WorkspaceAccessibilityStatusSnapshot,
  type WorkspaceSurfaceFact,
} from '../../experience/workspace/workspaceAccessibilityStatusModel';
import type { WorkspaceFocusReason } from '../../experience/workspace/workspaceFocusRecoveryModel';
import { WorkspaceFocusRecoveryRuntime } from '../../experience/workspace/workspaceFocusRecoveryRuntime';
import { WorkspaceLandmarkRuntime } from '../../experience/workspace/workspaceLandmarkRuntime';
import type {
  WorkspaceLandmarkHealth,
  WorkspaceLandmarkInventorySnapshot,
  WorkspaceLandmarkEntry,
} from '../../experience/workspace/workspaceLandmarkInventoryModel';
import type { WorkspaceFocusZone } from '../../experience/workspace/workspaceAccessibilityModel';

export interface WorkspaceAccessibilityContextValue {
  readonly snapshot: WorkspaceAccessibilityRuntimeSnapshot;
  readonly landmarks: WorkspaceLandmarkInventorySnapshot;
  readonly preferences: WorkspaceAccessibilityPreferences;
  readonly status: WorkspaceAccessibilityStatusSnapshot;
  readonly updatePreferences: (patch: WorkspaceAccessibilityPreferencePatch) => void;
  readonly resetPreferences: () => void;
  readonly focusZone: (zone: WorkspaceFocusZone, reason?: WorkspaceFocusReason) => boolean;
  readonly announce: (text: string, priority?: 'polite' | 'assertive') => void;
}

export interface WorkspaceAccessibilityProviderProps {
  readonly children: ReactNode;
}

const WorkspaceAccessibilityContext = createContext<WorkspaceAccessibilityContextValue | null>(null);

const fallbackSnapshot = Object.freeze({
  accessibility: Object.freeze({
    modality: 'unknown' as const,
    focusZone: 'unknown' as const,
    previousFocusZone: 'unknown' as const,
    dialogDepth: 0,
    commandPaletteOpen: false,
    mapBusy: false,
    online: true,
    reducedMotion: false,
    forcedColors: false,
    sequence: 0,
  }),
  liveRegions: Object.freeze({
    polite: Object.freeze([]),
    assertive: Object.freeze([]),
    recentFingerprints: Object.freeze({}),
    sequence: 0,
  }),
  politeAnnouncement: '',
  assertiveAnnouncement: '',
}) satisfies WorkspaceAccessibilityRuntimeSnapshot;

const entryFor = (
  inventory: WorkspaceLandmarkInventorySnapshot,
  id: WorkspaceLandmarkEntry['id'],
): WorkspaceLandmarkEntry | null => inventory.entries.find((entry) => entry.id === id) ?? null;

const surfaceFact = (
  id: WorkspaceSurfaceFact['id'],
  label: string,
  entries: readonly (WorkspaceLandmarkEntry | null)[],
): WorkspaceSurfaceFact => Object.freeze({
  id,
  label,
  available: entries.some((entry) => entry?.present === true && entry.visible),
  focusable: entries.some((entry) => entry?.usable === true),
});

const surfaceFactsFromLandmarks = (
  inventory: WorkspaceLandmarkInventorySnapshot,
): readonly WorkspaceSurfaceFact[] => Object.freeze([
  surfaceFact('workspace', 'Çalışma alanı', [
    entryFor(inventory, 'workspace'),
    entryFor(inventory, 'navigation'),
    entryFor(inventory, 'search'),
  ]),
  surfaceFact('tools', 'Araçlar', [
    entryFor(inventory, 'sidebar'),
    entryFor(inventory, 'toolbar'),
  ]),
  surfaceFact('map', 'Harita', [entryFor(inventory, 'map')]),
  surfaceFact('command-palette', 'Komut merkezi', [entryFor(inventory, 'command-palette')]),
  surfaceFact('dialog', 'Açık iletişim penceresi', [entryFor(inventory, 'dialog')]),
]);

const applyRootFacts = (
  root: HTMLElement | null,
  snapshot: WorkspaceAccessibilityRuntimeSnapshot,
  landmarks: WorkspaceLandmarkInventorySnapshot,
  preferences: WorkspaceAccessibilityPreferences,
): void => {
  if (!root) return;
  root.dataset.workspaceInput = snapshot.accessibility.modality;
  root.dataset.workspaceFocusZone = snapshot.accessibility.focusZone;
  root.dataset.workspaceOnline = String(snapshot.accessibility.online);
  root.dataset.workspaceMapBusy = String(snapshot.accessibility.mapBusy);
  root.dataset.workspaceReducedMotion = String(snapshot.accessibility.reducedMotion);
  root.dataset.workspaceForcedColors = String(snapshot.accessibility.forcedColors);
  root.dataset.workspaceKeyboardGuide = String(preferences.showKeyboardGuide);
  root.dataset.workspaceLandmarkHealth = landmarks.health;
  root.dataset.workspaceLandmarkReady = String(landmarks.readyCount);
  root.dataset.workspaceLandmarkTotal = String(landmarks.totalCount);
};

const surfaceIsOpen = (
  inventory: WorkspaceLandmarkInventorySnapshot,
  id: 'dialog' | 'command-palette',
): boolean => {
  const entry = entryFor(inventory, id);
  return Boolean(entry?.present && entry.visible && !entry.disabled);
};

const landmarkHealthAnnouncement = (
  health: WorkspaceLandmarkHealth,
  landmarks: WorkspaceLandmarkInventorySnapshot,
): Readonly<{ text: string; priority: 'polite' | 'assertive' }> | null => {
  if (health === 'critical') {
    return Object.freeze({
      text: `${landmarks.missingRequiredCount} temel çalışma alanı hedefi şu anda kullanılamıyor.`,
      priority: 'assertive',
    });
  }
  if (health === 'degraded') {
    return Object.freeze({
      text: 'Çalışma alanındaki bazı gezinme hedefleri sınırlı durumda.',
      priority: 'polite',
    });
  }
  return Object.freeze({
    text: 'Çalışma alanı gezinme hedefleri yeniden kullanıma hazır.',
    priority: 'polite',
  });
};

export const WorkspaceAccessibilityProvider = ({ children }: WorkspaceAccessibilityProviderProps): ReactNode => {
  const runtime = useMemo(() => new WorkspaceAccessibilityRuntime({
    onError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.workspace-accessibility-runtime',
      }, 'warn');
    },
  }), []);
  const landmarkRuntime = useMemo(() => new WorkspaceLandmarkRuntime({
    onError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.workspace-landmark-runtime',
      }, 'warn');
    },
  }), []);
  const focusRuntime = useMemo(() => new WorkspaceFocusRecoveryRuntime({
    focusRingAttribute: 'data-workspace-focus-recovery',
    onError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.workspace-focus-recovery',
      }, 'warn');
    },
  }), []);

  const preferenceSession = useMemo(() => {
    let storage: Storage | null = null;
    if (typeof window !== 'undefined') {
      try {
        storage = window.sessionStorage;
      } catch (error) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.workspace-accessibility-preferences.storage',
        }, 'warn');
      }
    }
    return createWorkspaceAccessibilityPreferenceSession(
      createWorkspaceAccessibilityPreferenceStorage(storage),
    );
  }, []);

  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    () => fallbackSnapshot,
  );
  const landmarks = useSyncExternalStore(
    landmarkRuntime.subscribe,
    landmarkRuntime.getSnapshot,
    landmarkRuntime.getSnapshot,
  );
  const preferences = useSyncExternalStore(
    preferenceSession.subscribe,
    preferenceSession.snapshot,
    preferenceSession.snapshot,
  );
  const previousLandmarkHealth = useRef<WorkspaceLandmarkHealth | null>(null);
  const previousDialogOpen = useRef(false);
  const previousPaletteOpen = useRef(false);

  useEffect(() => {
    runtime.start();
    landmarkRuntime.start();
    return () => {
      focusRuntime.dispose();
      landmarkRuntime.dispose();
      runtime.dispose();
    };
  }, [focusRuntime, landmarkRuntime, runtime]);

  useEffect(() => () => preferenceSession.dispose(), [preferenceSession]);

  useEffect(() => {
    const root = typeof document === 'undefined'
      ? null
      : document.getElementById('app-shell');
    applyRootFacts(root, snapshot, landmarks, preferences);
  }, [landmarks, preferences, snapshot]);

  useEffect(() => {
    const dialogOpen = surfaceIsOpen(landmarks, 'dialog');
    const paletteOpen = surfaceIsOpen(landmarks, 'command-palette');
    runtime.setDialogDepth(dialogOpen ? 1 : 0);
    runtime.setCommandPaletteOpen(paletteOpen);

    const dialogClosed = previousDialogOpen.current && !dialogOpen;
    const paletteClosed = previousPaletteOpen.current && !paletteOpen;
    previousDialogOpen.current = dialogOpen;
    previousPaletteOpen.current = paletteOpen;

    if (!dialogClosed && !paletteClosed) return;
    if (typeof document !== 'undefined' && document.activeElement instanceof Element && document.activeElement !== document.body && document.activeElement.isConnected) return;

    const accessibility = runtime.getSnapshot().accessibility;
    const result = focusRuntime.recoverDisconnectedFocus({
      preferredZone: accessibility.previousFocusZone,
      originZone: accessibility.previousFocusZone,
      modality: accessibility.modality,
      inventory: landmarks,
      dialogDepth: dialogOpen ? 1 : 0,
      paletteOpen,
      reason: dialogClosed ? 'dialog-close' : 'palette-close',
    });
    if (result.ok) {
      runtimeDiagnostics.record('experience.workspace-focus-recovered', {
        zone: result.zone,
        reason: dialogClosed ? 'dialog-close' : 'palette-close',
        fallback: result.usedFallback,
      });
    }
  }, [focusRuntime, landmarks, runtime]);

  useEffect(() => {
    const previous = previousLandmarkHealth.current;
    previousLandmarkHealth.current = landmarks.health;
    if (previous === null || previous === landmarks.health) return;
    const announcement = landmarkHealthAnnouncement(landmarks.health, landmarks);
    if (!announcement) return;
    runtime.announce(announcement.text, announcement.priority, 'navigation');
  }, [landmarks, runtime]);

  useEffect(() => {
    if (!preferences.autoRevealOnOffline || snapshot.accessibility.online) return;
    preferenceSession.update({ showStatusCenter: true });
  }, [preferenceSession, preferences.autoRevealOnOffline, snapshot.accessibility.online]);

  useEffect(() => {
    if (!preferences.autoRevealOnMapBusy || !snapshot.accessibility.mapBusy) return;
    preferenceSession.update({ showStatusCenter: true });
  }, [preferenceSession, preferences.autoRevealOnMapBusy, snapshot.accessibility.mapBusy]);

  const status = useMemo(() => createWorkspaceAccessibilityStatusSnapshot(
    snapshot.accessibility,
    surfaceFactsFromLandmarks(landmarks),
  ), [landmarks, snapshot.accessibility]);

  const updatePreferences = useCallback((patch: WorkspaceAccessibilityPreferencePatch): void => {
    preferenceSession.update(patch);
  }, [preferenceSession]);

  const resetPreferences = useCallback((): void => {
    preferenceSession.reset();
  }, [preferenceSession]);

  const focusZone = useCallback((zone: WorkspaceFocusZone, reason: WorkspaceFocusReason = 'landmark-cycle'): boolean => {
    const result = focusRuntime.focusZone(zone, runtime.getSnapshot().accessibility.modality);
    if (!result.ok) {
      runtime.announce('İstenen çalışma alanı şu anda kullanılamıyor.', 'assertive', 'navigation');
      return false;
    }
    runtimeDiagnostics.record('experience.workspace-focus-navigation', {
      zone,
      reason,
      recovered: result.usedFallback,
      temporaryTabIndex: result.temporaryTabIndex,
    });
    runtime.announce(`${zone === 'map' ? 'Harita' : zone === 'tools' ? 'Araçlar' : zone === 'workspace' ? 'Çalışma alanı' : zone === 'command-palette' ? 'Komut merkezi' : 'İletişim penceresi'} odağına geçildi.`, 'polite', 'navigation');
    return true;
  }, [focusRuntime, runtime]);

  const announce = useCallback((text: string, priority: 'polite' | 'assertive' = 'polite'): void => {
    runtime.announce(text, priority, 'system');
  }, [runtime]);

  const contextValue = useMemo<WorkspaceAccessibilityContextValue>(() => Object.freeze({
    snapshot,
    landmarks,
    preferences,
    status,
    updatePreferences,
    resetPreferences,
    focusZone,
    announce,
  }), [announce, focusZone, landmarks, preferences, resetPreferences, snapshot, status, updatePreferences]);

  return (
    <WorkspaceAccessibilityContext.Provider value={contextValue}>
      {children}
      <div className="workspace-accessibility-live" aria-live="polite" aria-atomic="true">
        {snapshot.politeAnnouncement}
      </div>
      <div className="workspace-accessibility-live" role="alert" aria-live="assertive" aria-atomic="true">
        {snapshot.assertiveAnnouncement}
      </div>
    </WorkspaceAccessibilityContext.Provider>
  );
};

export const useWorkspaceAccessibility = (): WorkspaceAccessibilityContextValue => {
  const context = useContext(WorkspaceAccessibilityContext);
  if (!context) throw new Error('useWorkspaceAccessibility must be used inside WorkspaceAccessibilityProvider.');
  return context;
};

export default WorkspaceAccessibilityProvider;
