import {
  createWorkspaceAccessibilityState,
  enterWorkspaceFocusZone,
  setWorkspaceConnectivity,
  setWorkspaceInputModality,
  setWorkspaceMapBusy,
  setWorkspaceMediaAccessibility,
  type WorkspaceAccessibilitySnapshot,
  type WorkspaceAccessibilityTransition,
  type WorkspaceFocusZone,
} from './workspaceAccessibilityModel';
import {
  createWorkspaceLiveRegionState,
  enqueueWorkspaceLiveMessage,
  workspaceLiveRegionText,
  type WorkspaceLiveRegionState,
  type WorkspaceLiveTopic,
} from './workspaceLiveRegionModel';

export interface WorkspaceAccessibilityRuntimeSnapshot {
  readonly accessibility: WorkspaceAccessibilitySnapshot;
  readonly liveRegions: WorkspaceLiveRegionState;
  readonly politeAnnouncement: string;
  readonly assertiveAnnouncement: string;
}

export interface WorkspaceAccessibilityRuntimeOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface WorkspaceAccessibilityRuntimeDiagnostics {
  readonly operationFailures: number;
  readonly reporterFailures: number;
  readonly rejectedListeners: number;
  readonly activeListeners: number;
  readonly mapBindings: number;
  readonly waitingForMap: boolean;
  readonly lastFailureKind: string | null;
  readonly started: boolean;
}

type Listener = () => void;

const MAX_LISTENERS = 64;

const FOCUS_ZONE_SELECTORS: readonly Readonly<{ zone: WorkspaceFocusZone; selector: string }>[] = Object.freeze([
  Object.freeze({ zone: 'dialog', selector: '[role="dialog"],[aria-modal="true"]' }),
  Object.freeze({ zone: 'command-palette', selector: '[data-experience-command-palette]' }),
  Object.freeze({ zone: 'tools', selector: '#sidebar,[data-workspace-tools]' }),
  Object.freeze({ zone: 'map', selector: '#esri-map-container,[data-workspace-map]' }),
  Object.freeze({ zone: 'workspace', selector: '#experience-workspace-controls,[data-workspace-shell]' }),
]);

const topicForAnnouncement = (text: string): WorkspaceLiveTopic => {
  if (/bağlant/i.test(text)) return 'connectivity';
  if (/harita/i.test(text)) return 'map';
  if (/pencere/i.test(text)) return 'dialog';
  if (/komut/i.test(text)) return 'command';
  return 'system';
};

const zoneForTarget = (target: EventTarget | null): WorkspaceFocusZone => {
  if (!(target instanceof Element)) return 'unknown';
  for (const candidate of FOCUS_ZONE_SELECTORS) {
    if (target.closest(candidate.selector)) return candidate.zone;
  }
  return 'unknown';
};

const failureKind = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const freezeSnapshot = (
  accessibility: WorkspaceAccessibilitySnapshot,
  liveRegions: WorkspaceLiveRegionState,
): WorkspaceAccessibilityRuntimeSnapshot => Object.freeze({
  accessibility,
  liveRegions,
  politeAnnouncement: workspaceLiveRegionText(liveRegions, 'polite'),
  assertiveAnnouncement: workspaceLiveRegionText(liveRegions, 'assertive'),
});

export class WorkspaceAccessibilityRuntime {
  private readonly doc: Document | undefined;
  private readonly win: Window | undefined;
  private readonly now: () => number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly listeners = new Set<Listener>();
  private accessibility = createWorkspaceAccessibilityState();
  private liveRegions = createWorkspaceLiveRegionState();
  private snapshot = freezeSnapshot(this.accessibility, this.liveRegions);
  private started = false;
  private reducedMotionQuery: MediaQueryList | null = null;
  private forcedColorsQuery: MediaQueryList | null = null;
  private mapObserver: MutationObserver | null = null;
  private rootObserver: MutationObserver | null = null;
  private observedMap: HTMLElement | null = null;
  private operationFailures = 0;
  private reporterFailures = 0;
  private rejectedListeners = 0;
  private mapBindings = 0;
  private lastFailureKind: string | null = null;

  constructor(options: WorkspaceAccessibilityRuntimeOptions = {}) {
    this.doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
    this.win = options.window ?? (typeof window === 'undefined' ? undefined : window);
    this.now = options.now ?? (() => Date.now());
    this.onError = options.onError;
  }

  readonly getSnapshot = (): WorkspaceAccessibilityRuntimeSnapshot => this.snapshot;

  readonly getDiagnostics = (): WorkspaceAccessibilityRuntimeDiagnostics => Object.freeze({
    operationFailures: this.operationFailures,
    reporterFailures: this.reporterFailures,
    rejectedListeners: this.rejectedListeners,
    activeListeners: this.listeners.size,
    mapBindings: this.mapBindings,
    waitingForMap: this.started && this.observedMap === null,
    lastFailureKind: this.lastFailureKind,
    started: this.started,
  });

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.listeners.has(listener)) return () => this.listeners.delete(listener);
    if (this.listeners.size >= MAX_LISTENERS) {
      this.rejectedListeners += 1;
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    const doc = this.doc;
    const win = this.win;
    if (!doc || !win) return;

    this.safe(() => {
      doc.addEventListener('keydown', this.onKeyDown, true);
      doc.addEventListener('pointerdown', this.onPointerDown, true);
      doc.addEventListener('touchstart', this.onTouchStart, true);
      doc.addEventListener('focusin', this.onFocusIn, true);
      win.addEventListener('online', this.onOnline);
      win.addEventListener('offline', this.onOffline);
    });

    this.safe(() => {
      this.reducedMotionQuery = win.matchMedia('(prefers-reduced-motion: reduce)');
      this.forcedColorsQuery = win.matchMedia('(forced-colors: active)');
      this.reducedMotionQuery.addEventListener?.('change', this.onMediaChange);
      this.forcedColorsQuery.addEventListener?.('change', this.onMediaChange);
      this.syncMedia();
    });

    this.safe(() => this.apply(setWorkspaceConnectivity(this.accessibility, win.navigator.onLine)));
    this.observeMapBusy();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    const doc = this.doc;
    const win = this.win;
    this.safe(() => {
      doc?.removeEventListener('keydown', this.onKeyDown, true);
      doc?.removeEventListener('pointerdown', this.onPointerDown, true);
      doc?.removeEventListener('touchstart', this.onTouchStart, true);
      doc?.removeEventListener('focusin', this.onFocusIn, true);
      win?.removeEventListener('online', this.onOnline);
      win?.removeEventListener('offline', this.onOffline);
      this.reducedMotionQuery?.removeEventListener?.('change', this.onMediaChange);
      this.forcedColorsQuery?.removeEventListener?.('change', this.onMediaChange);
      this.mapObserver?.disconnect();
      this.rootObserver?.disconnect();
    });
    this.mapObserver = null;
    this.rootObserver = null;
    this.observedMap = null;
    this.reducedMotionQuery = null;
    this.forcedColorsQuery = null;
    this.listeners.clear();
  }

  announce(text: string, priority: 'polite' | 'assertive' = 'polite', topic: WorkspaceLiveTopic = 'system'): void {
    const next = enqueueWorkspaceLiveMessage(this.liveRegions, { text, priority, topic, now: this.now() });
    if (next === this.liveRegions) return;
    this.liveRegions = next;
    this.publish();
  }

  setMapBusy(busy: boolean): void {
    this.apply(setWorkspaceMapBusy(this.accessibility, busy));
  }

  private readonly onKeyDown = (): void => this.apply(setWorkspaceInputModality(this.accessibility, 'keyboard'));
  private readonly onPointerDown = (event: PointerEvent): void => this.apply(setWorkspaceInputModality(this.accessibility, event.pointerType === 'touch' ? 'touch' : 'pointer'));
  private readonly onTouchStart = (): void => this.apply(setWorkspaceInputModality(this.accessibility, 'touch'));
  private readonly onFocusIn = (event: FocusEvent): void => this.apply(enterWorkspaceFocusZone(this.accessibility, zoneForTarget(event.target)));
  private readonly onOnline = (): void => this.apply(setWorkspaceConnectivity(this.accessibility, true));
  private readonly onOffline = (): void => this.apply(setWorkspaceConnectivity(this.accessibility, false));
  private readonly onMediaChange = (): void => this.syncMedia();

  private syncMedia(): void {
    this.apply(setWorkspaceMediaAccessibility(this.accessibility, {
      reducedMotion: this.reducedMotionQuery?.matches ?? false,
      forcedColors: this.forcedColorsQuery?.matches ?? false,
    }));
  }

  private syncObservedMap(): void {
    const map = this.observedMap;
    if (!map || !map.isConnected) {
      if (map && !map.isConnected) {
        this.mapObserver?.disconnect();
        this.mapObserver = null;
        this.observedMap = null;
        this.observeMapBusy();
      }
      return;
    }
    const phase = map.dataset.workspacePhase;
    this.setMapBusy(phase === 'booting' || phase === 'updating');
  }

  private bindMap(map: HTMLElement): void {
    if (this.observedMap === map) {
      this.syncObservedMap();
      return;
    }
    this.mapObserver?.disconnect();
    this.observedMap = map;
    this.mapBindings += 1;
    this.syncObservedMap();
    if (typeof MutationObserver === 'undefined') return;
    this.safe(() => {
      this.mapObserver = new MutationObserver(() => this.syncObservedMap());
      this.mapObserver.observe(map, { attributes: true, attributeFilter: ['data-workspace-phase'] });
    });
    this.rootObserver?.disconnect();
    this.rootObserver = null;
  }

  private observeMapBusy(): void {
    const doc = this.doc;
    if (!doc || !this.started) return;
    const map = doc.getElementById('esri-map-container');
    if (map instanceof HTMLElement) {
      this.bindMap(map);
      return;
    }
    if (typeof MutationObserver === 'undefined' || this.rootObserver || !doc.body) return;
    this.safe(() => {
      this.rootObserver = new MutationObserver(() => {
        const candidate = doc.getElementById('esri-map-container');
        if (candidate instanceof HTMLElement) this.bindMap(candidate);
      });
      this.rootObserver.observe(doc.body, { childList: true, subtree: true });
    });
  }

  private apply(transition: WorkspaceAccessibilityTransition): void {
    const changed = transition.state !== this.accessibility;
    this.accessibility = transition.state;
    if (transition.announcement) {
      this.liveRegions = enqueueWorkspaceLiveMessage(this.liveRegions, {
        topic: topicForAnnouncement(transition.announcement),
        priority: transition.priority,
        text: transition.announcement,
        now: this.now(),
      });
    }
    if (changed || transition.announcement) this.publish();
  }

  private publish(): void {
    this.snapshot = freezeSnapshot(this.accessibility, this.liveRegions);
    for (const listener of this.listeners) this.safe(listener);
  }

  private reportError(error: unknown): void {
    this.operationFailures += 1;
    this.lastFailureKind = failureKind(error);
    if (!this.onError) return;
    try {
      this.onError(error);
    } catch (reporterError) {
      this.reporterFailures += 1;
      this.lastFailureKind = `reporter:${failureKind(reporterError)}`;
    }
  }

  private safe(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.reportError(error);
    }
  }
}

export const workspaceFocusZoneForElement = (element: Element | null): WorkspaceFocusZone => zoneForTarget(element);
