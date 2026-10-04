export type ResultWorkspaceShortcutAction =
  | 'focus-results'
  | 'focus-map'
  | 'toggle-filters'
  | 'toggle-selection'
  | 'open-detail'
  | 'close-surface'
  | 'next-landmark'
  | 'previous-landmark';

export interface ResultWorkspaceShortcutEvent {
  readonly key: string;
  readonly code?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly composing?: boolean;
  readonly editable?: boolean;
}

export interface ResultWorkspaceShortcutContext {
  readonly detailOpen: boolean;
  readonly filterOpen: boolean;
  readonly hasFocusedResult: boolean;
  readonly hasResults: boolean;
  readonly viewport: 'phone' | 'tablet' | 'desktop';
}

export interface ResultWorkspaceShortcutResolution {
  readonly action: ResultWorkspaceShortcutAction | null;
  readonly handled: boolean;
  readonly preventDefault: boolean;
  readonly reason: 'matched' | 'editable' | 'composing' | 'modified' | 'repeat' | 'unavailable' | 'unknown';
  readonly announcement: string;
}

export interface ResultWorkspaceShortcutDescriptor {
  readonly action: ResultWorkspaceShortcutAction;
  readonly keys: string;
  readonly label: string;
  readonly available: boolean;
}

const blocked = (reason: ResultWorkspaceShortcutResolution['reason']): ResultWorkspaceShortcutResolution =>
  Object.freeze({ action: null, handled: false, preventDefault: false, reason, announcement: '' });

const resolved = (action: ResultWorkspaceShortcutAction, announcement = ''): ResultWorkspaceShortcutResolution =>
  Object.freeze({ action, handled: true, preventDefault: true, reason: 'matched', announcement });

const normalizeKey = (key: string): string => String(key ?? '').trim().toLowerCase();

export function resolveArcGisResultWorkspaceShortcut(
  event: ResultWorkspaceShortcutEvent,
  context: ResultWorkspaceShortcutContext,
): ResultWorkspaceShortcutResolution {
  if (event.composing) return blocked('composing');
  if (event.editable) return blocked('editable');
  if (event.repeat) return blocked('repeat');
  if (event.altKey || event.ctrlKey || event.metaKey) return blocked('modified');

  const key = normalizeKey(event.key);
  if (key === 'f6') {
    return resolved(event.shiftKey ? 'previous-landmark' : 'next-landmark');
  }
  if (key === 'escape') {
    if (context.detailOpen || context.filterOpen) return resolved('close-surface', 'Panel kapatıldı');
    return blocked('unavailable');
  }
  if (!event.shiftKey) return blocked('unknown');
  if (key === 'm') return resolved('focus-map', 'Harita');
  if (key === 'r') {
    return context.hasResults ? resolved('focus-results', 'Sonuçlar') : blocked('unavailable');
  }
  if (key === 'f') return resolved('toggle-filters', context.filterOpen ? 'Filtreleri kapat' : 'Filtreleri aç');
  if (key === 'enter') {
    return context.hasFocusedResult ? resolved('open-detail', 'Sonuç ayrıntıları') : blocked('unavailable');
  }
  if (key === ' ') {
    return context.hasFocusedResult ? resolved('toggle-selection') : blocked('unavailable');
  }
  return blocked('unknown');
}

export function createArcGisResultWorkspaceShortcutDescriptors(
  context: ResultWorkspaceShortcutContext,
): readonly ResultWorkspaceShortcutDescriptor[] {
  return Object.freeze([
    Object.freeze({ action: 'next-landmark', keys: 'F6', label: 'Sonraki bölge', available: true }),
    Object.freeze({ action: 'previous-landmark', keys: 'Shift+F6', label: 'Önceki bölge', available: true }),
    Object.freeze({ action: 'focus-map', keys: 'Shift+M', label: 'Haritaya git', available: true }),
    Object.freeze({ action: 'focus-results', keys: 'Shift+R', label: 'Sonuçlara git', available: context.hasResults }),
    Object.freeze({ action: 'toggle-filters', keys: 'Shift+F', label: context.filterOpen ? 'Filtreleri kapat' : 'Filtreleri aç', available: true }),
    Object.freeze({ action: 'open-detail', keys: 'Shift+Enter', label: 'Ayrıntıyı aç', available: context.hasFocusedResult }),
    Object.freeze({ action: 'toggle-selection', keys: 'Shift+Space', label: 'Seçimi değiştir', available: context.hasFocusedResult }),
    Object.freeze({ action: 'close-surface', keys: 'Escape', label: 'Açık paneli kapat', available: context.detailOpen || context.filterOpen }),
  ]);
}
