export type ShortcutModifier = 'alt' | 'ctrl' | 'meta' | 'shift';

export interface ShortcutChord {
  readonly key: string;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface ShortcutPolicyDecision {
  readonly allowed: boolean;
  readonly reason:
    | 'allowed'
    | 'default-prevented'
    | 'repeat'
    | 'composition'
    | 'editable-target'
    | 'modal-scope';
}

const EDITABLE_TAGS = new Set(['input', 'textarea', 'select']);
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], dialog[open]';

const asElement = (target: EventTarget | null): Element | null => target instanceof Element ? target : null;

export const normalizeShortcutKey = (key: string): string => {
  if (key === 'Esc') return 'escape';
  if (key === 'Spacebar') return ' ';
  return key.trim().toLocaleLowerCase('tr-TR');
};

export const createShortcutChord = (event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): ShortcutChord => ({
  key: normalizeShortcutKey(event.key),
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

const hasEditableRole = (element: Element): boolean => {
  const role = element.getAttribute('role')?.trim().toLocaleLowerCase('en-US');
  return role ? EDITABLE_ROLES.has(role) : false;
};

export const isShortcutEditableTarget = (target: EventTarget | null): boolean => {
  const element = asElement(target);
  if (!element) return false;

  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current instanceof HTMLElement && current.isContentEditable) return true;
    if (EDITABLE_TAGS.has(current.tagName.toLocaleLowerCase('en-US'))) return true;
    if (hasEditableRole(current)) return true;
    if (current.getAttribute('data-shortcut-scope') === 'editable') return true;
    if (current.getAttribute('data-shortcut-scope') === 'global') return false;
  }
  return false;
};

const isInsideModalScope = (target: EventTarget | null): boolean => {
  const element = asElement(target);
  if (!element) return false;
  return Boolean(element.closest(MODAL_SELECTOR));
};

export const evaluateShortcutPolicy = (
  event: Pick<KeyboardEvent, 'defaultPrevented' | 'repeat' | 'isComposing' | 'target'>,
): ShortcutPolicyDecision => {
  if (event.defaultPrevented) return { allowed: false, reason: 'default-prevented' };
  if (event.repeat) return { allowed: false, reason: 'repeat' };
  if (event.isComposing) return { allowed: false, reason: 'composition' };
  if (isShortcutEditableTarget(event.target)) return { allowed: false, reason: 'editable-target' };
  if (isInsideModalScope(event.target)) return { allowed: false, reason: 'modal-scope' };
  return { allowed: true, reason: 'allowed' };
};

export const chordMatches = (
  chord: ShortcutChord,
  definition: {
    readonly key: string;
    readonly alt?: boolean;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
  },
): boolean => chord.key === normalizeShortcutKey(definition.key)
  && chord.alt === Boolean(definition.alt)
  && chord.ctrl === Boolean(definition.ctrl)
  && chord.meta === Boolean(definition.meta)
  && chord.shift === Boolean(definition.shift);

export const formatShortcutLabel = (
  definition: { readonly key: string; readonly alt?: boolean; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean },
  platform: 'mac' | 'other' = 'other',
): string => {
  const parts: string[] = [];
  if (definition.ctrl) parts.push(platform === 'mac' ? 'Control' : 'Ctrl');
  if (definition.meta) parts.push(platform === 'mac' ? 'Command' : 'Meta');
  if (definition.alt) parts.push(platform === 'mac' ? 'Option' : 'Alt');
  if (definition.shift) parts.push('Shift');
  const key = normalizeShortcutKey(definition.key);
  parts.push(key.length === 1 ? key.toLocaleUpperCase('tr-TR') : key);
  return parts.join('+');
};

export const auditShortcutDefinitions = (
  definitions: readonly {
    readonly id: string;
    readonly key: string;
    readonly alt?: boolean;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
  }[],
): readonly string[] => {
  const issues: string[] = [];
  const ids = new Set<string>();
  const chords = new Map<string, string>();

  definitions.forEach((definition) => {
    const id = definition.id.trim();
    if (!id) issues.push('Kısayol kimliği boş olamaz.');
    else if (ids.has(id)) issues.push(`Tekrarlanan kısayol kimliği: ${id}`);
    else ids.add(id);

    const chord = [
      normalizeShortcutKey(definition.key),
      Boolean(definition.alt),
      Boolean(definition.ctrl),
      Boolean(definition.meta),
      Boolean(definition.shift),
    ].join('|');
    const owner = chords.get(chord);
    if (owner) issues.push(`Kısayol çakışması: ${owner} ve ${id || '(boş)'}`);
    else chords.set(chord, id || '(boş)');
  });

  return Object.freeze(issues);
};
