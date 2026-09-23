import type { ShortcutDefinition } from '../shortcutRuntime';
import { experienceBus } from '../experienceSession';
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

const announceUnavailableTarget = (target: WorkspaceShortcutTarget): void => {
  experienceBus.emit('kentrehberi:announcement', {
    message: `${target.label} şu anda kullanılamıyor.`,
    politeness: 'polite',
  });
};

const focusOrAnnounce = (document: Document, target: WorkspaceShortcutTarget): void => {
  if (!focusTarget(document, target)) announceUnavailableTarget(target);
};

export const createWorkspaceShortcuts = (document: Document): readonly ShortcutDefinition[] => Object.freeze([
  Object.freeze({
    id: 'experience-command-palette', key: 'k', ctrlOrMeta: true, alt: false, shift: false,
    allowInEditable: true, priority: 100,
    handler: () => experienceBus.command({ name: 'command-palette', source: 'experience-keyboard' }),
  }),
  Object.freeze({
    id: 'experience-focus-map', key: 'm', alt: true, ctrl: false, meta: false, shift: false, priority: 90,
    handler: () => focusOrAnnounce(document, MAP_TARGET),
  }),
  Object.freeze({
    id: 'experience-focus-sidebar', key: 's', alt: true, ctrl: false, meta: false, shift: false, priority: 90,
    handler: () => focusOrAnnounce(document, SIDEBAR_TARGET),
  }),
  Object.freeze({
    id: 'experience-help', key: '?', ctrl: false, alt: false, meta: false, shift: true, priority: 80,
    handler: () => experienceBus.command({ name: 'help', source: 'experience-keyboard' }),
  }),
]);

export const WORKSPACE_SHORTCUT_HINTS = Object.freeze([
  Object.freeze({ id: 'experience-command-palette', label: 'Komut merkezi', keys: 'Ctrl/⌘ + K' }),
  Object.freeze({ id: 'experience-focus-map', label: 'Haritaya odaklan', keys: 'Alt + M' }),
  Object.freeze({ id: 'experience-focus-sidebar', label: 'Araç paneline odaklan', keys: 'Alt + S' }),
  Object.freeze({ id: 'experience-help', label: 'Kısayollar ve yardım', keys: '?' }),
] as const);
