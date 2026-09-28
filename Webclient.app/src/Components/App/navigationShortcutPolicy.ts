export type NavigationShortcutIntent =
  | 'focus-search'
  | 'clear-search'
  | 'none';

export interface NavigationShortcutEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  readonly target?: EventTarget | null;
}

export interface NavigationShortcutDecision {
  readonly intent: NavigationShortcutIntent;
  readonly preventDefault: boolean;
  readonly reason:
    | 'accepted'
    | 'already-prevented'
    | 'composition'
    | 'repeat'
    | 'unsupported-modifier'
    | 'editable-target'
    | 'unsupported-key';
}

const NONE: NavigationShortcutDecision = Object.freeze({
  intent: 'none',
  preventDefault: false,
  reason: 'unsupported-key',
});

function isElement(value: EventTarget | null | undefined): value is Element {
  return typeof Element !== 'undefined' && value instanceof Element;
}

function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!isElement(target)) return false;
  if (target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
  const control = target.closest('input, textarea, select');
  if (!control) return false;
  if (control instanceof HTMLInputElement) {
    const type = control.type.toLowerCase();
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
  }
  return true;
}

/**
 * Pure keyboard policy for the persistent shell.
 *
 * Keeping this decision outside React makes the global shortcut deterministic,
 * testable and safe around editors, IME composition and browser-reserved
 * modifier combinations. It deliberately exposes only semantic intents; DOM
 * focus remains owned by the component that renders the search field.
 */
export function resolveNavigationShortcut(event: NavigationShortcutEvent): NavigationShortcutDecision {
  if (event.defaultPrevented) {
    return { intent: 'none', preventDefault: false, reason: 'already-prevented' };
  }
  if (event.isComposing) {
    return { intent: 'none', preventDefault: false, reason: 'composition' };
  }
  if (event.repeat) {
    return { intent: 'none', preventDefault: false, reason: 'repeat' };
  }

  const key = event.key.toLocaleLowerCase('tr-TR');
  const primaryModifier = Boolean(event.ctrlKey || event.metaKey);

  if (key === 'k') {
    if (!primaryModifier || event.altKey || event.shiftKey || (event.ctrlKey && event.metaKey)) {
      return { intent: 'none', preventDefault: false, reason: 'unsupported-modifier' };
    }
    if (isEditableTarget(event.target)) {
      return { intent: 'none', preventDefault: false, reason: 'editable-target' };
    }
    return { intent: 'focus-search', preventDefault: true, reason: 'accepted' };
  }

  if (key === 'escape' && isEditableTarget(event.target)) {
    return { intent: 'clear-search', preventDefault: false, reason: 'accepted' };
  }

  return NONE;
}
