import type { ShortcutDefinition } from '../shortcutRuntime';
import { experienceBus } from '../experienceSession';
import type { ExperienceBus } from '../experienceRuntime';
import { activateSkipTarget } from '../accessibilityRuntime';

export interface WorkspaceShortcutTarget {
  readonly selector: string;
  readonly label: string;
}

const MAP_TARGET: WorkspaceShortcutTarget = Object.freeze({ selector: '#esri-map-container', label: 'harita' });
const SIDEBAR_TARGET: WorkspaceShortcutTarget = Object.freeze({ selector: '#sidebar', label: 'araç paneli' });

const focusTarget = (document: Document, target: WorkspaceShortcutTarget): boolean => {
  const element = document.querySelector(target.selector);
  return element instanceof HTMLElement ? activateSkipTarget(element) : false;
};

const announceUnavailableTarget = (bus: ExperienceBus, target: WorkspaceShortcutTarget): void => {
  bus.emit('kentrehberi:announcement', {
    message: `${target.label} şu anda kullanılamıyor.`,
    politeness: 'polite',
  });
};

const focusOrAnnounce = (document: Document, bus: ExperienceBus, target: WorkspaceShortcutTarget): void => {
  if (!focusTarget(document, target)) announceUnavailableTarget(bus, target);
};

export const createWorkspaceShortcuts = (
  document: Document,
  bus: ExperienceBus = experienceBus,
): readonly ShortcutDefinition[] => Object.freeze([
  Object.freeze({
    id: 'experience-command-palette', key: 'k', ctrlOrMeta: true, alt: false, shift: false,
    allowInEditable: true, priority: 100,
    handler: () => bus.command({ name: 'command-palette', source: 'experience-keyboard' }),
  }),
  Object.freeze({
    id: 'experience-focus-map', key: 'm', alt: true, ctrl: false, meta: false, shift: false, priority: 90,
    handler: () => focusOrAnnounce(document, bus, MAP_TARGET),
  }),
  Object.freeze({
    id: 'experience-focus-sidebar', key: 's', alt: true, ctrl: false, meta: false, shift: false, priority: 90,
    handler: () => focusOrAnnounce(document, bus, SIDEBAR_TARGET),
  }),
  Object.freeze({
    id: 'experience-help', key: '?', ctrl: false, alt: false, meta: false, shift: true, priority: 80,
    handler: () => bus.command({ name: 'help', source: 'experience-keyboard' }),
  }),
]);

export const WORKSPACE_SHORTCUT_HINTS = Object.freeze([
  Object.freeze({ id: 'experience-command-palette', label: 'Komut merkezi', keys: 'Ctrl/⌘ + K' }),
  Object.freeze({ id: 'experience-focus-map', label: 'Haritaya odaklan', keys: 'Alt + M' }),
  Object.freeze({ id: 'experience-focus-sidebar', label: 'Araç paneline odaklan', keys: 'Alt + S' }),
  Object.freeze({ id: 'experience-help', label: 'Kısayollar ve yardım', keys: '?' }),
] as const);
