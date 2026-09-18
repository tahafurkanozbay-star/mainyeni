export interface ShellCommandContext {
  readonly [key: string]: unknown;
}

export interface ShellCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly group?: string;
  readonly priority?: number;
  readonly enabled?: (context: ShellCommandContext) => boolean;
  readonly execute: (context: ShellCommandContext) => void | Promise<void>;
}

export interface ShellCommandMatch {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: string | null;
  readonly shortcut: string | null;
  readonly score: number;
  readonly enabled: boolean;
}

export interface ShellCommandSnapshot {
  readonly revision: number;
  readonly commandCount: number;
  readonly shortcutCount: number;
  readonly commands: readonly ShellCommandMatch[];
  readonly observerFailures: number;
}

export interface ShellCommandEvent {
  readonly type: 'registered' | 'unregistered' | 'executed' | 'failed';
  readonly commandId: string;
  readonly timestamp: number;
  readonly error: unknown | null;
}

export interface ShellCommandRegistry {
  readonly register: (definition: ShellCommandDefinition) => () => boolean;
  readonly unregister: (id: string) => boolean;
  readonly has: (id: string) => boolean;
  readonly search: (query: string, context?: ShellCommandContext, limit?: number) => readonly ShellCommandMatch[];
  readonly resolveShortcut: (shortcut: string, context?: ShellCommandContext) => ShellCommandMatch | null;
  readonly execute: (id: string, context?: ShellCommandContext) => Promise<boolean>;
  readonly snapshot: (context?: ShellCommandContext) => ShellCommandSnapshot;
  readonly subscribe: (listener: (event: ShellCommandEvent) => void) => () => boolean;
  readonly destroy: () => void;
}

export interface ShellCommandRegistryOptions {
  readonly capacity?: number;
  readonly now?: () => number;
}

interface StoredCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly shortcut: string | null;
  readonly group: string | null;
  readonly priority: number;
  readonly enabled?: (context: ShellCommandContext) => boolean;
  readonly execute: (context: ShellCommandContext) => void | Promise<void>;
  readonly searchText: string;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (normalized.length > max) throw new RangeError(`${label} exceeds ${max} characters.`);
  return normalized;
};

export const normalizeCommandSearchText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('tr-TR')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ı/gu, 'i')
    .replace(/[^a-z0-9çğıöşü\s-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

export const normalizeCommandShortcut = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const aliases: Readonly<Record<string, string>> = Object.freeze({
    control: 'Ctrl',
    ctrl: 'Ctrl',
    cmd: 'Meta',
    command: 'Meta',
    meta: 'Meta',
    option: 'Alt',
    alt: 'Alt',
    shift: 'Shift',
    escape: 'Escape',
    esc: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    space: 'Space',
  });
  const order = ['Ctrl', 'Meta', 'Alt', 'Shift'];
  const tokens = value
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => aliases[token.toLowerCase()] ?? (
      token.length === 1 ? token.toUpperCase() : token.slice(0, 1).toUpperCase() + token.slice(1)
    ));

  const modifiers = [...new Set(tokens.filter((token) => order.includes(token)))]
    .sort((left, right) => order.indexOf(left) - order.indexOf(right));
  const keys = tokens.filter((token) => !order.includes(token));
  if (keys.length !== 1) throw new TypeError('Command shortcut must contain exactly one non-modifier key.');
  return [...modifiers, keys[0]].join('+');
};

const priorityOf = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(-100, Math.trunc(parsed)));
};

const enabledFor = (command: StoredCommand, context: ShellCommandContext): boolean => {
  if (!command.enabled) return true;
  try {
    return command.enabled(context) === true;
  } catch {
    return false;
  }
};

const matchOf = (
  command: StoredCommand,
  score: number,
  context: ShellCommandContext,
): ShellCommandMatch => Object.freeze({
  id: command.id,
  label: command.label,
  description: command.description,
  group: command.group,
  shortcut: command.shortcut,
  score,
  enabled: enabledFor(command, context),
});

export const createShellCommandRegistry = (
  options: ShellCommandRegistryOptions = {},
): ShellCommandRegistry => {
  const capacityRaw = Number(options.capacity);
  const capacity = Number.isFinite(capacityRaw)
    ? Math.min(500, Math.max(1, Math.trunc(capacityRaw)))
    : 100;
  const now = options.now ?? (() => Date.now());
  const commands = new Map<string, StoredCommand>();
  const shortcuts = new Map<string, string>();
  const listeners = new Set<(event: ShellCommandEvent) => void>();
  let revision = 0;
  let destroyed = false;
  let observerFailures = 0;

  const timestamp = (): number => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('Command registry clock must be finite.');
    return value;
  };

  const assertActive = (): void => {
    if (destroyed) throw new Error('Command registry is destroyed.');
  };

  const emit = (type: ShellCommandEvent['type'], commandId: string, error: unknown = null): void => {
    const event = Object.freeze({ type, commandId, timestamp: timestamp(), error });
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        observerFailures += 1;
      }
    }
  };

  const register = (definition: ShellCommandDefinition): (() => boolean) => {
    assertActive();
    if (!definition || typeof definition.execute !== 'function') {
      throw new TypeError('Command execute handler is required.');
    }
    const id = text(definition.id, 'Command id', 128);
    if (commands.has(id)) throw new Error(`Command is already registered: ${id}`);
    if (commands.size >= capacity) throw new Error('Command registry capacity exceeded.');

    const label = text(definition.label, 'Command label', 180);
    const description = typeof definition.description === 'string'
      ? definition.description.trim().slice(0, 500)
      : '';
    const group = typeof definition.group === 'string' && definition.group.trim()
      ? definition.group.trim().slice(0, 120)
      : null;
    const shortcut = normalizeCommandShortcut(definition.shortcut);
    if (shortcut && shortcuts.has(shortcut)) {
      throw new Error(`Command shortcut is already registered: ${shortcut}`);
    }

    const keywords = Object.freeze(
      (definition.keywords ?? [])
        .map((keyword) => normalizeCommandSearchText(keyword))
        .filter(Boolean)
        .slice(0, 24),
    );
    const stored: StoredCommand = Object.freeze({
      id,
      label,
      description,
      keywords,
      shortcut,
      group,
      priority: priorityOf(definition.priority),
      ...(definition.enabled ? { enabled: definition.enabled } : {}),
      execute: definition.execute,
      searchText: normalizeCommandSearchText([label, description, group ?? '', ...keywords].join(' ')),
    });

    commands.set(id, stored);
    if (shortcut) shortcuts.set(shortcut, id);
    revision += 1;
    emit('registered', id);
    return () => unregister(id);
  };

  const unregister = (idInput: string): boolean => {
    assertActive();
    const id = text(idInput, 'Command id', 128);
    const command = commands.get(id);
    if (!command) return false;
    commands.delete(id);
    if (command.shortcut) shortcuts.delete(command.shortcut);
    revision += 1;
    emit('unregistered', id);
    return true;
  };

  const has = (idInput: string): boolean => {
    assertActive();
    return commands.has(text(idInput, 'Command id', 128));
  };

  const search = (
    queryInput: string,
    context: ShellCommandContext = {},
    limitInput = 20,
  ): readonly ShellCommandMatch[] => {
    assertActive();
    const query = normalizeCommandSearchText(queryInput);
    const limit = Number.isFinite(limitInput) ? Math.min(100, Math.max(1, Math.trunc(limitInput))) : 20;
    if (!query) return Object.freeze([]);
    const tokens = query.split(' ').filter(Boolean);
    const ranked = [...commands.values()]
      .filter((command) => tokens.every((token) => command.searchText.includes(token)))
      .map((command) => {
        const label = normalizeCommandSearchText(command.label);
        const exact = label === query ? 0 : 1;
        const prefix = label.startsWith(query) ? 0 : 1;
        const position = Math.max(0, command.searchText.indexOf(query));
        const score = command.priority * 1000 - exact * 100 - prefix * 50 - position;
        return matchOf(command, score, context);
      })
      .sort((left, right) =>
        Number(right.enabled) - Number(left.enabled)
        || right.score - left.score
        || left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base' }))
      .slice(0, limit);
    return Object.freeze(ranked);
  };

  const resolveShortcut = (
    shortcutInput: string,
    context: ShellCommandContext = {},
  ): ShellCommandMatch | null => {
    assertActive();
    const shortcut = normalizeCommandShortcut(shortcutInput);
    if (!shortcut) return null;
    const id = shortcuts.get(shortcut);
    if (!id) return null;
    const command = commands.get(id);
    return command ? matchOf(command, command.priority * 1000, context) : null;
  };

  const execute = async (
    idInput: string,
    context: ShellCommandContext = {},
  ): Promise<boolean> => {
    assertActive();
    const id = text(idInput, 'Command id', 128);
    const command = commands.get(id);
    if (!command || !enabledFor(command, context)) return false;
    try {
      await command.execute(context);
      emit('executed', id);
      return true;
    } catch (error) {
      emit('failed', id, error);
      throw error;
    }
  };

  const snapshot = (context: ShellCommandContext = {}): ShellCommandSnapshot => {
    assertActive();
    const matches = [...commands.values()]
      .map((command) => matchOf(command, command.priority * 1000, context))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return Object.freeze({
      revision,
      commandCount: commands.size,
      shortcutCount: shortcuts.size,
      commands: Object.freeze(matches),
      observerFailures,
    });
  };

  const subscribe = (listener: (event: ShellCommandEvent) => void): (() => boolean) => {
    assertActive();
    if (typeof listener !== 'function') throw new TypeError('Command listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    if (destroyed) return;
    commands.clear();
    shortcuts.clear();
    listeners.clear();
    destroyed = true;
  };

  return Object.freeze({
    register,
    unregister,
    has,
    search,
    resolveShortcut,
    execute,
    snapshot,
    subscribe,
    destroy,
  });
};
