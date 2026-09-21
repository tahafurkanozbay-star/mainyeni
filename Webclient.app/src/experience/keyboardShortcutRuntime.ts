export type ShortcutScope = "global" | "map" | "panel" | "dialog";

export interface ShortcutDefinition {
  id: string;
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  scope?: ShortcutScope;
  allowInEditable?: boolean;
  preventDefault?: boolean;
  enabled?: () => boolean;
  run: (event: KeyboardEvent) => void;
}

export interface ShortcutRuntimeOptions {
  document?: Document;
  initialScope?: ShortcutScope;
  onError?: (error: unknown, shortcutId: string) => void;
}

export interface ShortcutRuntimeSnapshot {
  scope: ShortcutScope;
  registered: number;
  enabled: number;
  revision: number;
}

export type ShortcutRuntimeListener = (
  snapshot: Readonly<ShortcutRuntimeSnapshot>,
  previous: Readonly<ShortcutRuntimeSnapshot>,
) => void;

const clone = (value: ShortcutRuntimeSnapshot): ShortcutRuntimeSnapshot => ({ ...value });

const normalizeKey = (key: string): string => key.length === 1 ? key.toLocaleLowerCase("tr-TR") : key;

const isEditable = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
};

const sameChord = (definition: ShortcutDefinition, event: KeyboardEvent): boolean =>
  normalizeKey(definition.key) === normalizeKey(event.key) &&
  Boolean(definition.ctrl) === event.ctrlKey &&
  Boolean(definition.alt) === event.altKey &&
  Boolean(definition.shift) === event.shiftKey &&
  Boolean(definition.meta) === event.metaKey;

const scopeMatches = (definition: ShortcutDefinition, scope: ShortcutScope): boolean =>
  (definition.scope ?? "global") === "global" || (definition.scope ?? "global") === scope;

export class KeyboardShortcutRuntime {
  private readonly document: Document;
  private readonly onError: ShortcutRuntimeOptions["onError"];
  private readonly definitions = new Map<string, ShortcutDefinition>();
  private readonly listeners = new Set<ShortcutRuntimeListener>();
  private current: ShortcutRuntimeSnapshot;
  private disposed = false;

  constructor(options: ShortcutRuntimeOptions = {}) {
    const document = options.document ?? globalThis.document;
    if (!document) throw new Error("KeyboardShortcutRuntime bir Document gerektirir.");
    this.document = document;
    this.onError = options.onError;
    this.current = { scope: options.initialScope ?? "global", registered: 0, enabled: 0, revision: 0 };
    this.document.addEventListener("keydown", this.onKeyDown, true);
  }

  get snapshot(): Readonly<ShortcutRuntimeSnapshot> {
    return clone(this.current);
  }

  subscribe(listener: ShortcutRuntimeListener, emitCurrent = false): () => void {
    this.assertActive();
    this.listeners.add(listener);
    if (emitCurrent) this.notifyOne(listener, this.current, this.current);
    return () => this.listeners.delete(listener);
  }

  register(definition: ShortcutDefinition): () => void {
    this.assertActive();
    const id = definition.id.trim();
    if (!id) throw new Error("Klavye kısayolu id alanı boş olamaz.");
    if (!definition.key) throw new Error(`Klavye kısayolu '${id}' bir key gerektirir.`);
    if (this.definitions.has(id)) throw new Error(`Klavye kısayolu '${id}' zaten kayıtlı.`);
    this.definitions.set(id, { ...definition, id });
    this.commit();
    return () => {
      if (this.disposed) return;
      if (this.definitions.delete(id)) this.commit();
    };
  }

  replace(definition: ShortcutDefinition): void {
    this.assertActive();
    const id = definition.id.trim();
    if (!id) throw new Error("Klavye kısayolu id alanı boş olamaz.");
    this.definitions.set(id, { ...definition, id });
    this.commit();
  }

  unregister(id: string): boolean {
    this.assertActive();
    const deleted = this.definitions.delete(id);
    if (deleted) this.commit();
    return deleted;
  }

  setScope(scope: ShortcutScope): void {
    this.assertActive();
    if (scope === this.current.scope) return;
    this.current = { ...this.current, scope };
    this.commit(true);
  }

  list(): ReadonlyArray<Readonly<ShortcutDefinition>> {
    this.assertActive();
    return Array.from(this.definitions.values(), (definition) => ({ ...definition }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.document.removeEventListener("keydown", this.onKeyDown, true);
    this.definitions.clear();
    this.listeners.clear();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const editable = isEditable(event.target);
    const definition = Array.from(this.definitions.values()).find((candidate) =>
      scopeMatches(candidate, this.current.scope)
      && (!editable || candidate.allowInEditable === true)
      && sameChord(candidate, event)
      && this.isEnabled(candidate)
    );
    if (!definition) return;
    if (definition.preventDefault !== false) event.preventDefault();
    try {
      definition.run(event);
    } catch (error) {
      this.report(error, definition.id);
    }
  };

  private isEnabled(definition: ShortcutDefinition): boolean {
    if (!definition.enabled) return true;
    try {
      return definition.enabled();
    } catch (error) {
      this.report(error, definition.id);
      return false;
    }
  }

  private countEnabled(): number {
    return Array.from(this.definitions.values()).reduce(
      (count, definition) => count + (scopeMatches(definition, this.current.scope) && this.isEnabled(definition) ? 1 : 0),
      0,
    );
  }

  private commit(scopeAlreadyChanged = false): void {
    const previous = clone(this.current);
    const registered = this.definitions.size;
    const enabled = this.countEnabled();
    if (!scopeAlreadyChanged && registered === previous.registered && enabled === previous.enabled) return;
    this.current = {
      scope: this.current.scope,
      registered,
      enabled,
      revision: previous.revision + 1,
    };
    this.listeners.forEach((listener) => this.notifyOne(listener, this.current, previous));
  }

  private notifyOne(
    listener: ShortcutRuntimeListener,
    next: ShortcutRuntimeSnapshot,
    previous: ShortcutRuntimeSnapshot,
  ): void {
    try {
      listener(clone(next), clone(previous));
    } catch (error) {
      this.report(error, "observer");
    }
  }

  private report(error: unknown, shortcutId: string): void {
    if (this.onError) {
      try {
        this.onError(error, shortcutId);
        return;
      } catch (reportingError) {
        queueMicrotask(() => { throw reportingError; });
        return;
      }
    }
    queueMicrotask(() => { throw error; });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("KeyboardShortcutRuntime dispose edildikten sonra kullanılamaz.");
  }
}

export const createKeyboardShortcutRuntime = (options: ShortcutRuntimeOptions = {}): KeyboardShortcutRuntime =>
  new KeyboardShortcutRuntime(options);
