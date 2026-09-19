export type ShortcutModifier = 'alt' | 'ctrl' | 'meta' | 'shift';

export interface ShortcutContext {
  readonly event: KeyboardEvent;
  readonly target: EventTarget | null;
  readonly editable: boolean;
}

export interface ShortcutDefinition {
  readonly id: string;
  readonly key: string;
  readonly code?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly ctrlOrMeta?: boolean;
  readonly allowInEditable?: boolean;
  readonly allowRepeat?: boolean;
  readonly preventDefault?: boolean;
  readonly priority?: number;
  readonly enabled?: (context: ShortcutContext) => boolean;
  readonly handler: (context: ShortcutContext) => void;
}

export interface ShortcutRuntimeOptions {
  readonly document: Document;
  readonly shortcuts?: readonly ShortcutDefinition[];
  readonly onHandlerError?: (
    error: unknown,
    shortcut: Readonly<ShortcutDefinition>,
    event: KeyboardEvent,
  ) => void;
}

export interface ShortcutRuntimeSnapshot {
  readonly active: boolean;
  readonly shortcutCount: number;
  readonly sequence: number;
  readonly lastMatchedId: string | null;
}

export interface ShortcutRuntime {
  readonly register: (shortcut: ShortcutDefinition) => () => void;
  readonly replace: (shortcuts: readonly ShortcutDefinition[]) => void;
  readonly getSnapshot: () => ShortcutRuntimeSnapshot;
  readonly dispose: () => void;
}

const MAX_SHORTCUTS = 128;

const normalizeKey = (key: unknown): string => String(key ?? '')
  .trim()
  .toLocaleLowerCase('en-US');

const isHTMLElement = (value: unknown): value is HTMLElement =>
  typeof HTMLElement !== 'undefined' && value instanceof HTMLElement;

export const isEditableShortcutTarget = (target: EventTarget | null): boolean => {
  if (!isHTMLElement(target)) return false;
  if (target.isContentEditable) return true;

  const element = target.closest<HTMLElement>(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  );
  if (!element) return false;

  if (element instanceof HTMLInputElement) {
    const type = normalizeKey(element.type);
    return ![
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(type);
  }
  return true;
};

const modifierMatches = (
  expected: boolean | undefined,
  actual: boolean,
): boolean => expected === undefined || expected === actual;

const keyMatches = (
  shortcut: ShortcutDefinition,
  event: KeyboardEvent,
): boolean => {
  const expectedKey = normalizeKey(shortcut.key);
  const actualKey = normalizeKey(event.key);
  if (expectedKey !== actualKey) return false;
  if (shortcut.code && shortcut.code !== event.code) return false;

  if (shortcut.ctrlOrMeta) {
    if (!event.ctrlKey && !event.metaKey) return false;
    if (shortcut.ctrl === false && event.ctrlKey) return false;
    if (shortcut.meta === false && event.metaKey) return false;
  } else {
    if (!modifierMatches(shortcut.ctrl, event.ctrlKey)) return false;
    if (!modifierMatches(shortcut.meta, event.metaKey)) return false;
  }

  if (!modifierMatches(shortcut.alt, event.altKey)) return false;
  if (!modifierMatches(shortcut.shift, event.shiftKey)) return false;
  return true;
};

const normalizeShortcut = (
  shortcut: ShortcutDefinition,
): Readonly<ShortcutDefinition> => {
  const id = String(shortcut.id ?? '').trim();
  const key = String(shortcut.key ?? '').trim();
  if (!id) throw new Error('Shortcut id is required.');
  if (!key) throw new Error(`Shortcut key is required for "${id}".`);

  return Object.freeze({
    ...shortcut,
    id,
    key,
    priority: Number.isFinite(shortcut.priority)
      ? Math.trunc(shortcut.priority ?? 0)
      : 0,
  });
};

const sortShortcuts = (
  shortcuts: Iterable<Readonly<ShortcutDefinition>>,
): readonly Readonly<ShortcutDefinition>[] =>
  [...shortcuts].sort((left, right) => {
    const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
    return priorityDelta || left.id.localeCompare(right.id);
  });

const reportShortcutObserverError = (
  reporter: ShortcutRuntimeOptions['onHandlerError'],
  error: unknown,
  shortcut: Readonly<ShortcutDefinition>,
  event: KeyboardEvent,
): void => {
  if (!reporter) {
    globalThis.reportError?.(error);
    return;
  }

  try {
    reporter(error, shortcut, event);
  } catch (reportingError) {
    globalThis.reportError?.(reportingError);
  }
};

class KeyboardShortcutRuntime implements ShortcutRuntime {
  readonly #document: Document;
  readonly #onHandlerError: ShortcutRuntimeOptions['onHandlerError'];
  readonly #shortcuts = new Map<string, Readonly<ShortcutDefinition>>();

  #disposed = false;
  #sequence = 0;
  #lastMatchedId: string | null = null;

  constructor(options: ShortcutRuntimeOptions) {
    this.#document = options.document;
    this.#onHandlerError = options.onHandlerError;
    this.replace(options.shortcuts ?? []);
    this.#document.addEventListener('keydown', this.#onKeyDown, true);
  }

  #reportError(
    error: unknown,
    shortcut: Readonly<ShortcutDefinition>,
    event: KeyboardEvent,
  ): void {
    reportShortcutObserverError(this.#onHandlerError, error, shortcut, event);
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (
      this.#disposed
      || event.defaultPrevented
      || event.isComposing
      || event.key === 'Dead'
      || event.key === 'Process'
    ) {
      return;
    }

    const editable = isEditableShortcutTarget(event.target);
    const context: ShortcutContext = Object.freeze({
      event,
      target: event.target,
      editable,
    });

    for (const shortcut of sortShortcuts(this.#shortcuts.values())) {
      if (!keyMatches(shortcut, event)) continue;
      if (event.repeat && !shortcut.allowRepeat) continue;
      if (editable && !shortcut.allowInEditable) continue;

      let enabled = true;
      if (shortcut.enabled) {
        try {
          enabled = Boolean(shortcut.enabled(context));
        } catch (error) {
          this.#reportError(error, shortcut, event);
          continue;
        }
      }
      if (!enabled) continue;

      if (shortcut.preventDefault ?? true) event.preventDefault();

      this.#sequence += 1;
      this.#lastMatchedId = shortcut.id;

      try {
        shortcut.handler(context);
      } catch (error) {
        this.#reportError(error, shortcut, event);
      }
      return;
    }
  };

  register(shortcut: ShortcutDefinition): () => void {
    if (this.#disposed) return () => undefined;
    const normalized = normalizeShortcut(shortcut);

    if (
      !this.#shortcuts.has(normalized.id)
      && this.#shortcuts.size >= MAX_SHORTCUTS
    ) {
      throw new Error(`Shortcut capacity exceeded (${MAX_SHORTCUTS}).`);
    }

    this.#shortcuts.set(normalized.id, normalized);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      if (this.#shortcuts.get(normalized.id) === normalized) {
        this.#shortcuts.delete(normalized.id);
      }
    };
  }

  replace(shortcuts: readonly ShortcutDefinition[]): void {
    if (this.#disposed) return;
    if (shortcuts.length > MAX_SHORTCUTS) {
      throw new Error(`Shortcut capacity exceeded (${MAX_SHORTCUTS}).`);
    }

    const next = new Map<string, Readonly<ShortcutDefinition>>();
    for (const shortcut of shortcuts) {
      const normalized = normalizeShortcut(shortcut);
      if (next.has(normalized.id)) {
        throw new Error(`Duplicate shortcut id "${normalized.id}".`);
      }
      next.set(normalized.id, normalized);
    }

    this.#shortcuts.clear();
    next.forEach((shortcut, id) => this.#shortcuts.set(id, shortcut));
  }

  getSnapshot(): ShortcutRuntimeSnapshot {
    return Object.freeze({
      active: !this.#disposed,
      shortcutCount: this.#shortcuts.size,
      sequence: this.#sequence,
      lastMatchedId: this.#lastMatchedId,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#document.removeEventListener('keydown', this.#onKeyDown, true);
    this.#shortcuts.clear();
  }
}

export const createShortcutRuntime = (
  options: ShortcutRuntimeOptions,
): ShortcutRuntime => new KeyboardShortcutRuntime(options);
