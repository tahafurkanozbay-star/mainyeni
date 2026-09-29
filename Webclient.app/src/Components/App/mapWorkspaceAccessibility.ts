export type MapWorkspacePhase = 'booting' | 'ready' | 'updating' | 'error';

export interface MapWorkspaceAccessibilitySnapshot {
  readonly revision: number;
  readonly phase: MapWorkspacePhase;
  readonly isInteractive: boolean;
  readonly isBusy: boolean;
  readonly announcement: string;
  readonly errorMessage: string | null;
}

export interface MapWorkspaceObserverDiagnostics {
  readonly failureCount: number;
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

type Listener = () => void;

export const MAP_WORKSPACE_OBSERVER_LIMIT = 64;
const MAX_ERROR_LENGTH = 180;

const isControlCode = (codePoint: number): boolean => codePoint < 32 || codePoint === 127;

const stripControlCharacters = (value: string): string => {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && isControlCode(codePoint) ? ' ' : character;
  }
  return sanitized;
};

const sanitizeMessage = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return stripControlCharacters(value).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH);
};

const classifyObserverFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const announcementFor = (phase: MapWorkspacePhase, errorMessage: string | null): string => {
  switch (phase) {
    case 'booting': return 'Harita çalışma alanı hazırlanıyor.';
    case 'ready': return 'Harita çalışma alanı kullanıma hazır.';
    case 'updating': return 'Harita görünümü güncelleniyor.';
    case 'error': return errorMessage ? `Harita hazırlanamadı. ${errorMessage}` : 'Harita çalışma alanı hazırlanamadı.';
  }
};

const createSnapshot = (
  revision: number,
  phase: MapWorkspacePhase,
  errorMessage: string | null,
): MapWorkspaceAccessibilitySnapshot => Object.freeze({
  revision,
  phase,
  isInteractive: phase === 'ready' || phase === 'updating',
  isBusy: phase === 'booting' || phase === 'updating',
  announcement: announcementFor(phase, errorMessage),
  errorMessage,
});

/**
 * Small external-store authority for map-shell accessibility state.
 * ArcGIS remains the map runtime authority; this class only translates its
 * lifecycle into stable semantic state for React and assistive technology.
 */
export class MapWorkspaceAccessibilityModel {
  private listeners = new Set<Listener>();
  private snapshot = createSnapshot(0, 'booting', null);
  private disposed = false;
  private observerDiagnostics: MapWorkspaceObserverDiagnostics = Object.freeze({
    failureCount: 0,
    activeObserverCount: 0,
    rejectedObserverCount: 0,
    lastFailureRevision: null,
    lastFailureKind: null,
    disposed: false,
  });

  readonly getSnapshot = (): MapWorkspaceAccessibilitySnapshot => this.snapshot;

  readonly getObserverDiagnostics = (): MapWorkspaceObserverDiagnostics => this.observerDiagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) {
      this.recordRejectedObserver();
      return () => undefined;
    }
    if (this.listeners.has(listener)) return () => this.unsubscribe(listener);
    if (this.listeners.size >= MAP_WORKSPACE_OBSERVER_LIMIT) {
      this.recordRejectedObserver();
      return () => undefined;
    }
    this.listeners.add(listener);
    this.refreshObserverCount();
    return () => this.unsubscribe(listener);
  };

  markReady(): void {
    this.transition('ready', null);
  }

  markUpdating(updating: boolean): void {
    if (!this.snapshot.isInteractive && this.snapshot.phase !== 'updating') return;
    this.transition(updating ? 'updating' : 'ready', null);
  }

  markError(error: unknown): void {
    const candidate = error instanceof Error ? error.message : error;
    const sanitized = sanitizeMessage(candidate);
    this.transition('error', sanitized || null);
  }

  reset(): void {
    this.transition('booting', null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  private recordRejectedObserver(): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      rejectedObserverCount: this.observerDiagnostics.rejectedObserverCount + 1,
    });
  }

  private unsubscribe(listener: Listener): void {
    if (!this.listeners.delete(listener)) return;
    this.refreshObserverCount();
  }

  private refreshObserverCount(): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      activeObserverCount: this.listeners.size,
    });
  }

  private recordObserverFailure(error: unknown): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      failureCount: this.observerDiagnostics.failureCount + 1,
      lastFailureRevision: this.snapshot.revision,
      lastFailureKind: classifyObserverFailure(error),
    });
  }

  private transition(phase: MapWorkspacePhase, errorMessage: string | null): void {
    if (this.disposed) return;
    if (this.snapshot.phase === phase && this.snapshot.errorMessage === errorMessage) return;
    this.snapshot = createSnapshot(this.snapshot.revision + 1, phase, errorMessage);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.recordObserverFailure(error);
      }
    }
  }
}
