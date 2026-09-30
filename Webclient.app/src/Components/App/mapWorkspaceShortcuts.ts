import {
  auditShortcutDefinitions,
  chordMatches,
  createShortcutChord,
  evaluateShortcutPolicy,
} from './mapWorkspaceShortcutPolicy';

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

const registryIssues = auditShortcutDefinitions(MAP_WORKSPACE_SHORTCUTS);
if (registryIssues.length > 0) throw new Error(`Map workspace shortcut registry is invalid: ${registryIssues.join('; ')}`);

export const resolveMapWorkspaceShortcut = (event: KeyboardEvent): MapWorkspaceShortcutDefinition | null => {
  if (!evaluateShortcutPolicy(event).allowed) return null;
  const chord = createShortcutChord(event);
  return MAP_WORKSPACE_SHORTCUTS.find((shortcut) => chordMatches(chord, shortcut)) ?? null;
};

export const shortcutHelpText = (): string => MAP_WORKSPACE_SHORTCUTS
  .map((shortcut) => `${shortcut.label}: ${shortcut.description}`)
  .join('. ');

export interface MapWorkspaceShortcutEnvironment {
  readonly mapElement: HTMLElement | null;
  readonly navigationElement: HTMLElement | null;
  readonly windowManager: {
    readonly ToggleWindow: (windowId: string) => boolean;
    readonly ShowWindow: (windowId: string) => boolean;
  };
  readonly announce?: (message: string) => void;
}

export interface MapWorkspaceShortcutExecution {
  readonly handled: boolean;
  readonly action: MapWorkspaceShortcutAction | null;
  readonly announcement: string | null;
}

const ACTION_WINDOW_IDS: Partial<Record<MapWorkspaceShortcutAction, string>> = Object.freeze({
  'toggle-sidebar': 'sidebar',
  'open-command-center': 'experience-command-center',
  'open-basemap': 'basemap-widget',
  'open-measurement': 'measurement-widget',
  'open-feedback': 'feedback-widget',
});

const focusElement = (element: HTMLElement | null): boolean => {
  if (!element || !element.isConnected) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element || element.contains(document.activeElement);
};

export const executeMapWorkspaceShortcut = (
  shortcut: MapWorkspaceShortcutDefinition,
  environment: MapWorkspaceShortcutEnvironment,
): MapWorkspaceShortcutExecution => {
  let handled = false;

  switch (shortcut.action) {
    case 'focus-map':
      handled = focusElement(environment.mapElement);
      break;
    case 'focus-navigation':
      handled = focusElement(environment.navigationElement);
      break;
    case 'toggle-sidebar': {
      const windowId = ACTION_WINDOW_IDS[shortcut.action];
      handled = windowId ? environment.windowManager.ToggleWindow(windowId) : false;
      break;
    }
    default: {
      const windowId = ACTION_WINDOW_IDS[shortcut.action];
      handled = windowId ? environment.windowManager.ShowWindow(windowId) : false;
      break;
    }
  }

  const announcement = handled ? `${shortcut.description}. Kısayol: ${shortcut.label}.` : null;
  if (announcement) environment.announce?.(announcement);
  return { handled, action: handled ? shortcut.action : null, announcement };
};

export const handleMapWorkspaceKeyDown = (
  event: KeyboardEvent,
  environment: MapWorkspaceShortcutEnvironment,
): MapWorkspaceShortcutExecution => {
  const shortcut = resolveMapWorkspaceShortcut(event);
  if (!shortcut) return { handled: false, action: null, announcement: null };
  const result = executeMapWorkspaceShortcut(shortcut, environment);
  if (result.handled) event.preventDefault();
  return result;
};
