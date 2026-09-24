export type ShortcutScope = 'global' | 'map' | 'navigation' | 'table' | 'dialog';

export interface ShortcutHelpItemInput {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly keys: readonly string[];
  readonly scope: ShortcutScope;
  readonly category: string;
  readonly enabled?: boolean;
}

export interface ShortcutHelpRow {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly keys: readonly string[];
  readonly keyLabel: string;
  readonly scope: ShortcutScope;
  readonly category: string;
  readonly enabled: boolean;
  readonly tabIndex: 0 | -1;
  readonly positionInSet: number;
  readonly setSize: number;
}

export interface ShortcutHelpGroup {
  readonly category: string;
  readonly rows: readonly ShortcutHelpRow[];
}

export interface ShortcutHelpSnapshot {
  readonly revision: number;
  readonly open: boolean;
  readonly query: string;
  readonly scope: ShortcutScope | 'all';
  readonly groups: readonly ShortcutHelpGroup[];
  readonly resultCount: number;
  readonly focusedId: string | undefined;
  readonly emptyReason: 'none' | 'no-shortcuts' | 'no-results';
  readonly restoreFocusTarget: string | undefined;
}

export interface ShortcutHelpOptions {
  readonly items: readonly ShortcutHelpItemInput[];
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: ShortcutHelpSnapshot) => void;

interface ShortcutItem {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly keys: readonly string[];
  readonly scope: ShortcutScope;
  readonly category: string;
  readonly enabled: boolean;
  readonly search: string;
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase('tr-TR').replaceAll('ı', 'i');

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  Control: 'Ctrl', Meta: '⌘', Alt: 'Alt', Shift: 'Shift', Escape: 'Esc', Enter: 'Enter', Space: 'Boşluk', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End', Tab: 'Tab',
});

const formatKeys = (keys: readonly string[]): string => keys.map((key) => KEY_NAMES[key] ?? key.toLocaleUpperCase('tr-TR')).join(' + ');

export class ShortcutHelpModel {
  readonly #items: readonly ShortcutItem[];
  readonly #listeners = new Set<Listener>();
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  #open = false;
  #query = '';
  #scope: ShortcutScope | 'all' = 'all';
  #focusedId: string | undefined;
  #restoreFocusTarget: string | undefined;
  #revision = 0;
  #snapshot: ShortcutHelpSnapshot;

  constructor(options: ShortcutHelpOptions) {
    if (options.items.length > 500) throw new RangeError('Shortcut help supports at most 500 items.');
    const seen = new Set<string>();
    const items: ShortcutItem[] = [];
    for (const input of options.items) {
      const id = input.id.trim();
      const label = input.label.trim();
      const category = input.category.trim();
      if (!id || !label || !category || input.keys.length === 0) throw new Error('Shortcut identity, label, category and keys are required.');
      if (seen.has(id)) throw new Error(`Duplicate shortcut id: ${id}`);
      seen.add(id);
      const keys = input.keys.map((key) => key.trim()).filter(Boolean);
      if (keys.length !== input.keys.length) throw new Error('Shortcut keys must be non-empty.');
      const description = input.description?.trim() || undefined;
      items.push(Object.freeze({ id, label, category, scope: input.scope, keys: Object.freeze(keys), description, enabled: input.enabled ?? true, search: normalize(`${label} ${description ?? ''} ${category} ${formatKeys(keys)}`) }));
    }
    this.#items = Object.freeze(items);
    this.#onObserverError = options.onObserverError;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): ShortcutHelpSnapshot { return this.#snapshot; }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    this.#notifyOne(listener);
    return () => this.#listeners.delete(listener);
  }

  open(restoreFocusTarget?: string): void {
    if (this.#open) return;
    this.#open = true;
    this.#restoreFocusTarget = restoreFocusTarget?.trim() || undefined;
    this.#repairFocus();
    this.#commit();
  }

  close(): string | undefined {
    if (!this.#open) return this.#restoreFocusTarget;
    const target = this.#restoreFocusTarget;
    this.#open = false;
    this.#focusedId = undefined;
    this.#restoreFocusTarget = undefined;
    this.#commit();
    return target;
  }

  toggle(restoreFocusTarget?: string): void { if (this.#open) this.close(); else this.open(restoreFocusTarget); }

  setQuery(query: string): void {
    const next = query.trim();
    if (next === this.#query) return;
    this.#query = next;
    this.#repairFocus();
    this.#commit();
  }

  clearQuery(): void { this.setQuery(''); }

  setScope(scope: ShortcutScope | 'all'): void {
    if (scope === this.#scope) return;
    this.#scope = scope;
    this.#repairFocus();
    this.#commit();
  }

  focus(id: string): void {
    if (!this.#rows().some((row) => row.id === id && row.enabled) || id === this.#focusedId) return;
    this.#focusedId = id;
    this.#commit();
  }

  focusNext(): void { this.#moveFocus(1); }
  focusPrevious(): void { this.#moveFocus(-1); }
  focusFirst(): void { this.#focusBoundary('first'); }
  focusLast(): void { this.#focusBoundary('last'); }

  #filtered(): readonly ShortcutItem[] {
    const query = normalize(this.#query);
    return this.#items.filter((item) => (this.#scope === 'all' || item.scope === this.#scope) && (!query || item.search.includes(query)));
  }

  #rows(): readonly ShortcutHelpRow[] {
    const filtered = this.#filtered();
    return filtered.map((item, index) => Object.freeze({
      id: item.id, label: item.label, description: item.description, keys: item.keys, keyLabel: formatKeys(item.keys), scope: item.scope, category: item.category, enabled: item.enabled, tabIndex: item.id === this.#focusedId ? 0 : -1, positionInSet: index + 1, setSize: filtered.length,
    }));
  }

  #moveFocus(delta: -1 | 1): void {
    const rows = this.#rows().filter((row) => row.enabled);
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.id === this.#focusedId);
    const next = index < 0 ? 0 : (index + delta + rows.length) % rows.length;
    this.#focusedId = rows[next]?.id;
    this.#commit();
  }

  #focusBoundary(boundary: 'first' | 'last'): void {
    const rows = this.#rows().filter((row) => row.enabled);
    const row = boundary === 'first' ? rows[0] : rows.at(-1);
    if (!row || row.id === this.#focusedId) return;
    this.#focusedId = row.id;
    this.#commit();
  }

  #repairFocus(): void {
    const rows = this.#rows().filter((row) => row.enabled);
    if (rows.some((row) => row.id === this.#focusedId)) return;
    this.#focusedId = this.#open ? rows[0]?.id : undefined;
  }

  #buildSnapshot(): ShortcutHelpSnapshot {
    const rows = this.#rows();
    const categoryOrder: string[] = [];
    const byCategory = new Map<string, ShortcutHelpRow[]>();
    for (const row of rows) {
      if (!byCategory.has(row.category)) { byCategory.set(row.category, []); categoryOrder.push(row.category); }
      byCategory.get(row.category)?.push(row);
    }
    const groups = categoryOrder.map((category) => Object.freeze({ category, rows: Object.freeze(byCategory.get(category) ?? []) }));
    const emptyReason: ShortcutHelpSnapshot['emptyReason'] = this.#items.length === 0 ? 'no-shortcuts' : rows.length === 0 ? 'no-results' : 'none';
    return Object.freeze({ revision: this.#revision, open: this.#open, query: this.#query, scope: this.#scope, groups: Object.freeze(groups), resultCount: rows.length, focusedId: this.#focusedId, emptyReason, restoreFocusTarget: this.#restoreFocusTarget });
  }

  #commit(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) this.#notifyOne(listener);
  }

  #notifyOne(listener: Listener): void {
    try { listener(this.#snapshot); } catch (error) { this.#reportObserverError(error); }
  }

  #reportObserverError(error: unknown): void {
    if (!this.#onObserverError) return;
    try { this.#onObserverError(error); } catch (reportingError) { void reportingError; }
  }
}
