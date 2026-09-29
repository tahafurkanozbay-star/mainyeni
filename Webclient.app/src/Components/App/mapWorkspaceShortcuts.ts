export type MapWorkspaceShortcutAction =
  | 'focus-map'
  | 'focus-navigation'
  | 'toggle-sidebar'
  | 'open-command-center'
  | 'open-basemap'
  | 'open-measurement'
  | 'open-feedback';

export interface MapWorkspaceShortcutDefinition {
  readonly id: string;
  readonly action: MapWorkspaceShortcutAction;
  readonly key: string;
  readonly code?: string;
  readonly alt?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly label: string;
  readonly description: string;
}

export const MAP_WORKSPACE_SHORTCUTS: readonly MapWorkspaceShortcutDefinition[] = Object.freeze([
  { id: 'focus-map', action: 'focus-map', key: 'm', alt: true, label: 'Alt+M', description: 'Harita çalışma alanına odaklan' },
  { id: 'focus-navigation', action: 'focus-navigation', key: 'n', alt: true, label: 'Alt+N', description: 'Ana navigasyona odaklan' },
  { id: 'toggle-sidebar', action: 'toggle-sidebar', key: 'l', alt: true, label: 'Alt+L', description: 'Katman ve araç kenar çubuğunu aç veya kapat' },
  { id: 'command-center', action: 'open-command-center', key: 'k', ctrl: true, label: 'Ctrl+K', description: 'Komut merkezini aç' },
  { id: 'basemap', action: 'open-basemap', key: 'b', alt: true, label: 'Alt+B', description: 'Altlık harita seçicisini aç' },
  { id: 'measurement', action: 'open-measurement', key: 'r', alt: true, label: 'Alt+R', description: 'Ölçüm araçlarını aç' },
  { id: 'feedback', action: 'open-feedback', key: 'f', alt: true, label: 'Alt+F', description: 'Geri bildirim penceresini aç' },
]);

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

export const resolveMapWorkspaceShortcut = (event: KeyboardEvent): MapWorkspaceShortcutDefinition | null => {
  if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) return null;
  const key = event.key.toLocaleLowerCase('tr-TR');
  return MAP_WORKSPACE_SHORTCUTS.find((shortcut) =>
    shortcut.key === key
    && Boolean(shortcut.alt) === event.altKey
    && Boolean(shortcut.ctrl) === event.ctrlKey
    && Boolean(shortcut.meta) === event.metaKey
    && Boolean(shortcut.shift) === event.shiftKey
  ) ?? null;
};

export const shortcutHelpText = (): string => MAP_WORKSPACE_SHORTCUTS
  .map((shortcut) => `${shortcut.label}: ${shortcut.description}`)
  .join('. ');
