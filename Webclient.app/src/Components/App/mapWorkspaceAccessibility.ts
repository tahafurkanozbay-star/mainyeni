export type MapWorkspacePhase = 'booting' | 'ready' | 'updating' | 'error';

export interface MapWorkspaceAccessibilitySnapshot {
  readonly revision: number;
  readonly phase: MapWorkspacePhase;
  readonly isInteractive: boolean;
  readonly isBusy: boolean;
  readonly announcement: string;
  readonly errorMessage: string | null;
}

type Listener = () => void;

const MAX_LISTENERS = 64;
const MAX_ERROR_LENGTH = 180;

const sanitizeMessage = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH);
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

  readonly getSnapshot = (): MapWorkspaceAccessibilitySnapshot => this.snapshot;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed || this.listeners.has(listener) || this.listeners.size >= MAX_LISTENERS) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  }

  private transition(phase: MapWorkspacePhase, errorMessage: string | null): void {
    if (this.disposed) return;
    if (this.snapshot.phase === phase && this.snapshot.errorMessage === errorMessage) return;
    this.snapshot = createSnapshot(this.snapshot.revision + 1, phase, errorMessage);
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* observer failures must not break map lifecycle */ }
    }
  }
}
