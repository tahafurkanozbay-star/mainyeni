import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  collectWorkspaceSurfaceFacts,
  createWorkspaceAccessibilityStatusSnapshot,
  type WorkspaceAccessibilityStatusSnapshot,
} from '../../experience/workspace/workspaceAccessibilityStatusModel';
import {
  workspaceFocusTargetForZone,
  type WorkspaceFocusReason,
} from '../../experience/workspace/workspaceFocusRecoveryModel';
import type { WorkspaceFocusZone } from '../../experience/workspace/workspaceAccessibilityModel';

export interface WorkspaceAccessibilityContextValue {
  readonly snapshot: WorkspaceAccessibilityRuntimeSnapshot;
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

const isNaturallyFocusable = (element: HTMLElement): boolean => (
  element.matches('button,a[href],input,select,textarea,summary,iframe,[contenteditable="true"]')
  || element.tabIndex >= 0
);

const focusElement = (element: HTMLElement, showFocusRing: boolean): void => {
  const addedTabIndex = !isNaturallyFocusable(element) && !element.hasAttribute('tabindex');
  if (addedTabIndex) element.setAttribute('tabindex', '-1');
  if (showFocusRing) element.dataset.workspaceFocusRecovery = 'true';
  const cleanup = (): void => {
    element.removeEventListener('blur', cleanup);
    if (addedTabIndex) element.removeAttribute('tabindex');
    delete element.dataset.workspaceFocusRecovery;
  };
  element.addEventListener('blur', cleanup, { once: true });
  element.focus({ preventScroll: true });
  if (document.activeElement !== element) cleanup();
};

const applyRootFacts = (
  root: HTMLElement | null,
  snapshot: WorkspaceAccessibilityRuntimeSnapshot,
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
};

export const WorkspaceAccessibilityProvider = ({ children }: WorkspaceAccessibilityProviderProps): ReactNode => {
  const runtime = useMemo(() => new WorkspaceAccessibilityRuntime({
    onError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.workspace-accessibility-runtime',
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
  const preferences = useSyncExternalStore(
    preferenceSession.subscribe,
    preferenceSession.snapshot,
    preferenceSession.snapshot,
  );

  useEffect(() => {
    runtime.start();
    return () => runtime.dispose();
  }, [runtime]);

  useEffect(() => () => preferenceSession.dispose(), [preferenceSession]);

  useEffect(() => {
    const root = typeof document === 'undefined'
      ? null
      : document.getElementById('app-shell');
    applyRootFacts(root, snapshot, preferences);
  }, [preferences, snapshot]);

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
    collectWorkspaceSurfaceFacts(typeof document === 'undefined' ? null : document),
  ), [snapshot]);

  const updatePreferences = useCallback((patch: WorkspaceAccessibilityPreferencePatch): void => {
    preferenceSession.update(patch);
  }, [preferenceSession]);

  const resetPreferences = useCallback((): void => {
    preferenceSession.reset();
  }, [preferenceSession]);

  const focusZone = useCallback((zone: WorkspaceFocusZone, reason: WorkspaceFocusReason = 'landmark-cycle'): boolean => {
    if (typeof document === 'undefined') return false;
    const target = workspaceFocusTargetForZone(zone);
    if (!target) return false;
    const primary = document.querySelector<HTMLElement>(target.selector);
    const fallback = target.fallbackSelector
      ? document.querySelector<HTMLElement>(target.fallbackSelector)
      : null;
    const element = primary ?? fallback;
    if (!element) {
      runtime.announce('İstenen çalışma alanı şu anda kullanılamıyor.', 'assertive', 'navigation');
      return false;
    }
    const showFocusRing = snapshot.accessibility.modality === 'keyboard';
    focusElement(element, showFocusRing);
    runtimeDiagnostics.record('experience.workspace-focus-navigation', {
      zone,
      reason,
      recovered: primary === null,
    });
    runtime.announce(`${zone === 'map' ? 'Harita' : zone === 'tools' ? 'Araçlar' : zone === 'workspace' ? 'Çalışma alanı' : zone === 'command-palette' ? 'Komut merkezi' : 'İletişim penceresi'} odağına geçildi.`, 'polite', 'navigation');
    return true;
  }, [runtime, snapshot.accessibility.modality]);

  const announce = useCallback((text: string, priority: 'polite' | 'assertive' = 'polite'): void => {
    runtime.announce(text, priority, 'system');
  }, [runtime]);

  const contextValue = useMemo<WorkspaceAccessibilityContextValue>(() => Object.freeze({
    snapshot,
    preferences,
    status,
    updatePreferences,
    resetPreferences,
    focusZone,
    announce,
  }), [announce, focusZone, preferences, resetPreferences, snapshot, status, updatePreferences]);

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
