import {
  applyArcGisResultWorkspaceTableIntent,
  type WorkspaceTableIntent,
  type WorkspaceTableShortcutContext,
  type WorkspaceTableSnapshot,
  type WorkspaceTableTransition,
} from './ArcGisResultWorkspaceTableExperiencePolicy';

export interface WorkspaceTableKeyboardEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
}

export type WorkspaceTableKeyboardReason =
  | 'handled'
  | 'editable'
  | 'composing'
  | 'disabled'
  | 'modal'
  | 'modified'
  | 'repeat'
  | 'unavailable'
  | 'unsupported';

export interface WorkspaceTableKeyboardResolution {
  readonly intent: WorkspaceTableIntent | null;
  readonly handled: boolean;
  readonly preventDefault: boolean;
  readonly reason: WorkspaceTableKeyboardReason;
  readonly announcement: string;
}

export interface WorkspaceTableKeyboardDispatch extends WorkspaceTableKeyboardResolution {
  readonly transition: WorkspaceTableTransition | null;
}

const cleanKey = (value: unknown): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .trim()
  .slice(0, 32);

const blocked = (reason: WorkspaceTableKeyboardReason): WorkspaceTableKeyboardResolution => Object.freeze({
  intent: null,
  handled: false,
  preventDefault: false,
  reason,
  announcement: '',
});

const accepted = (intent: WorkspaceTableIntent, announcement = ''): WorkspaceTableKeyboardResolution => Object.freeze({
  intent: Object.freeze(intent),
  handled: true,
  preventDefault: true,
  reason: 'handled',
  announcement,
});

const hasRows = (snapshot: WorkspaceTableSnapshot): boolean => snapshot.rowIds.length > 0;
const hasColumns = (snapshot: WorkspaceTableSnapshot): boolean => snapshot.columns.length > 0;
const focusedColumn = (snapshot: WorkspaceTableSnapshot) => snapshot.columns[snapshot.focus.columnIndex] ?? null;

export function resolveArcGisResultWorkspaceTableKeyboard(
  snapshot: WorkspaceTableSnapshot,
  event: WorkspaceTableKeyboardEvent,
  context: WorkspaceTableShortcutContext = {},
): WorkspaceTableKeyboardResolution {
  if (context.disabled) return blocked('disabled');
  if (context.modalOpen) return blocked('modal');
  if (context.composing) return blocked('composing');
  if (context.editable) return blocked('editable');
  if (event.repeat) return blocked('repeat');

  const key = cleanKey(event.key);
  if (!key) return blocked('unsupported');

  const commandModifier = Boolean(event.ctrlKey || event.metaKey);
  if (event.altKey) return blocked('modified');
  if (commandModifier && key !== 'Home' && key !== 'End' && key.toLowerCase() !== 'a') return blocked('modified');
  if (!hasColumns(snapshot)) return blocked('unavailable');

  if (key === 'ArrowUp') return accepted({ type: 'move', rowDelta: -1, columnDelta: 0 });
  if (key === 'ArrowDown') return accepted({ type: 'move', rowDelta: 1, columnDelta: 0 });
  if (key === 'ArrowLeft') return accepted({ type: 'move', rowDelta: 0, columnDelta: -1 });
  if (key === 'ArrowRight') return accepted({ type: 'move', rowDelta: 0, columnDelta: 1 });
  if (key === 'Home') return accepted({ type: 'home', scope: commandModifier ? 'grid' : 'row' });
  if (key === 'End') return accepted({ type: 'end', scope: commandModifier ? 'grid' : 'row' });

  if (key === 'Enter' && snapshot.focus.inHeader) {
    const column = focusedColumn(snapshot);
    if (!column?.sortable) return blocked('unavailable');
    return accepted({ type: 'sort', columnKey: column.key }, `${column.label} sütunu sıralanıyor.`);
  }

  if ((key === ' ' || key === 'Spacebar') && !snapshot.focus.inHeader) {
    if (!hasRows(snapshot)) return blocked('unavailable');
    return accepted({ type: 'toggle-selection' });
  }

  if (key.toLowerCase() === 'a' && commandModifier && !snapshot.focus.inHeader) {
    if (!hasRows(snapshot) || snapshot.selectionMode !== 'multiple') return blocked('unavailable');
    return accepted({ type: 'select-all-visible' }, 'Görünür sonuçlar seçiliyor.');
  }

  if (key === 'Escape' && snapshot.selectedIds.length > 0) {
    return accepted({ type: 'clear-selection' }, 'Sonuç seçimi temizleniyor.');
  }

  return blocked('unsupported');
}

export function dispatchArcGisResultWorkspaceTableKeyboard(
  snapshot: WorkspaceTableSnapshot,
  event: WorkspaceTableKeyboardEvent,
  context: WorkspaceTableShortcutContext = {},
): WorkspaceTableKeyboardDispatch {
  const resolution = resolveArcGisResultWorkspaceTableKeyboard(snapshot, event, context);
  if (!resolution.intent) return Object.freeze({ ...resolution, transition: null });
  const transition = applyArcGisResultWorkspaceTableIntent(snapshot, resolution.intent);
  return Object.freeze({
    ...resolution,
    transition,
    announcement: transition.announcement || resolution.announcement,
  });
}
