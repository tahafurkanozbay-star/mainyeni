export type CommandScope = "global" | "map" | "overlay" | "navigation" | string;

export interface KeyboardCommand {
    id: string;
    keys: string | readonly string[];
    label: string;
    scope?: CommandScope;
    priority?: number;
    allowInEditable?: boolean;
    preventDefault?: boolean;
    stopPropagation?: boolean;
    enabled?: () => boolean;
    handler: (context: KeyboardCommandContext) => void | Promise<void>;
}

export interface KeyboardCommandContext {
    commandId: string;
    event: KeyboardEvent;
    scope: CommandScope;
    sequence: string;
}

export interface KeyboardCommandRuntimeOptions {
    target?: Document | HTMLElement;
    sequenceTimeoutMs?: number;
    onError?: (error: unknown, commandId: string) => void;
    onExecute?: (commandId: string) => void;
}

export interface KeyboardCommandSnapshot {
    commandCount: number;
    scopes: readonly CommandScope[];
    activeScopes: readonly CommandScope[];
    pendingSequence: string;
}

interface RegisteredCommand {
    command: KeyboardCommand;
    sequences: readonly string[];
    order: number;
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

const normalizeKey = (value: string): string => {
    const key = value.trim();
    if (!key) return "";
    if (key === " ") return "Space";
    if (key.length === 1) return key.toLocaleLowerCase("tr-TR");
    const aliases: Record<string, string> = {
        esc: "Escape",
        escape: "Escape",
        spacebar: "Space",
        space: "Space",
        return: "Enter",
        left: "ArrowLeft",
        right: "ArrowRight",
        up: "ArrowUp",
        down: "ArrowDown",
        del: "Delete"
    };
    return aliases[key.toLocaleLowerCase("en-US")] ?? `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
};

export const normalizeShortcut = (value: string): string => value
    .trim()
    .split(/\s+/)
    .map((chord) => {
        const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
        const modifiers = new Set<string>();
        let key = "";
        for (const part of parts) {
            const lower = part.toLocaleLowerCase("en-US");
            if (lower === "ctrl" || lower === "control") modifiers.add("Ctrl");
            else if (lower === "alt" || lower === "option") modifiers.add("Alt");
            else if (lower === "shift") modifiers.add("Shift");
            else if (lower === "meta" || lower === "cmd" || lower === "command") modifiers.add("Meta");
            else key = normalizeKey(part);
        }
        return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].filter(Boolean).join("+");
    })
    .filter(Boolean)
    .join(" ");

const chordFromEvent = (event: KeyboardEvent): string => {
    if (MODIFIER_KEYS.has(event.key)) return "";
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (event.metaKey) modifiers.push("Meta");
    return [...modifiers, normalizeKey(event.key)].filter(Boolean).join("+");
};

const isEditable = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    if (!(target instanceof HTMLInputElement)) return false;
    return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(target.type);
};

export class KeyboardCommandRuntime {
    private readonly target: Document | HTMLElement;
    private readonly timeoutMs: number;
    private readonly onError: ((error: unknown, commandId: string) => void) | undefined;
    private readonly onExecute: ((commandId: string) => void) | undefined;
    private readonly commands = new Map<string, RegisteredCommand>();
    private readonly scopeStack: CommandScope[] = ["global"];
    private order = 0;
    private sequence: string[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private destroyed = false;

    constructor(options: KeyboardCommandRuntimeOptions = {}) {
        this.target = options.target ?? document;
        this.timeoutMs = Math.max(150, options.sequenceTimeoutMs ?? 900);
        this.onError = options.onError;
        this.onExecute = options.onExecute;
        this.target.addEventListener("keydown", this.onKeyDown as EventListener);
    }

    register(command: KeyboardCommand): () => void {
        this.assertActive();
        const id = command.id.trim();
        if (!id) throw new Error("Keyboard command id boş olamaz.");
        if (this.commands.has(id)) throw new Error(`Keyboard command zaten kayıtlı: ${id}`);
        const rawKeys = typeof command.keys === "string" ? [command.keys] : [...command.keys];
        const sequences = rawKeys.map(normalizeShortcut).filter(Boolean);
        if (!sequences.length) throw new Error(`Keyboard command shortcut boş olamaz: ${id}`);
        this.commands.set(id, { command: { ...command, id }, sequences, order: ++this.order });
        return () => this.unregister(id);
    }

    unregister(id: string): void {
        this.commands.delete(id);
    }

    pushScope(scope: CommandScope): () => void {
        this.assertActive();
        const normalized = scope.trim();
        if (!normalized) throw new Error("Command scope boş olamaz.");
        this.scopeStack.push(normalized);
        this.clearSequence();
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            const index = this.scopeStack.lastIndexOf(normalized);
            if (index > 0) this.scopeStack.splice(index, 1);
            this.clearSequence();
        };
    }

    setScope(scope: CommandScope): void {
        this.assertActive();
        this.scopeStack.splice(1);
        if (scope !== "global") this.scopeStack.push(scope);
        this.clearSequence();
    }

    snapshot(): KeyboardCommandSnapshot {
        return Object.freeze({
            commandCount: this.commands.size,
            scopes: Object.freeze([...new Set([...this.commands.values()].map(({ command }) => command.scope ?? "global"))]),
            activeScopes: Object.freeze([...this.scopeStack]),
            pendingSequence: this.sequence.join(" ")
        });
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.target.removeEventListener("keydown", this.onKeyDown as EventListener);
        this.commands.clear();
        this.scopeStack.splice(1);
        this.clearSequence();
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (this.destroyed || event.defaultPrevented || event.isComposing) return;
        const chord = chordFromEvent(event);
        if (!chord) return;
        const nextSequence = [...this.sequence, chord];
        const candidates = this.candidates(event).filter(({ sequences }) =>
            sequences.some((sequence) => sequence === nextSequence.join(" ") || sequence.startsWith(`${nextSequence.join(" ")} `))
        );
        if (!candidates.length) {
            this.clearSequence();
            const fresh = this.candidates(event).filter(({ sequences }) =>
                sequences.some((sequence) => sequence === chord || sequence.startsWith(`${chord} `))
            );
            if (!fresh.length) return;
            this.consume(event, [chord], fresh);
            return;
        }
        this.consume(event, nextSequence, candidates);
    };

    private consume(event: KeyboardEvent, sequence: string[], candidates: RegisteredCommand[]): void {
        const text = sequence.join(" ");
        const exact = candidates.filter(({ sequences }) => sequences.includes(text));
        const longer = candidates.some(({ sequences }) => sequences.some((value) => value.startsWith(`${text} `)));
        if (exact.length && !longer) {
            const selected = this.select(exact);
            this.clearSequence();
            if (selected) this.execute(selected, event, text);
            return;
        }
        this.sequence = sequence;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            const selected = this.select(exact);
            this.clearSequence();
            if (selected) this.execute(selected, event, text);
        }, this.timeoutMs);
    }

    private candidates(event: KeyboardEvent): RegisteredCommand[] {
        const editable = isEditable(event.target);
        const activeScopes = new Set(this.scopeStack);
        return [...this.commands.values()].filter(({ command }) => {
            if (command.enabled?.() === false) return false;
            if (editable && command.allowInEditable !== true) return false;
            return activeScopes.has(command.scope ?? "global");
        });
    }

    private select(candidates: RegisteredCommand[]): RegisteredCommand | undefined {
        const topScope = this.scopeStack.at(-1) ?? "global";
        return [...candidates].sort((a, b) => {
            const aScope = (a.command.scope ?? "global") === topScope ? 1 : 0;
            const bScope = (b.command.scope ?? "global") === topScope ? 1 : 0;
            return bScope - aScope || (b.command.priority ?? 0) - (a.command.priority ?? 0) || a.order - b.order;
        })[0];
    }

    private execute(entry: RegisteredCommand, event: KeyboardEvent, sequence: string): void {
        const { command } = entry;
        if (command.preventDefault !== false) event.preventDefault();
        if (command.stopPropagation === true) event.stopPropagation();
        const scope = command.scope ?? "global";
        try {
            const result = command.handler({ commandId: command.id, event, scope, sequence });
            this.onExecute?.(command.id);
            if (result && typeof (result as Promise<void>).catch === "function") {
                void (result as Promise<void>).catch((error: unknown) => this.onError?.(error, command.id));
            }
        } catch (error) {
            this.onError?.(error, command.id);
        }
    }

    private clearSequence(): void {
        this.sequence = [];
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private assertActive(): void {
        if (this.destroyed) throw new Error("KeyboardCommandRuntime destroy edildikten sonra kullanılamaz.");
    }
}

export const createKeyboardCommandRuntime = (options: KeyboardCommandRuntimeOptions = {}): KeyboardCommandRuntime =>
    new KeyboardCommandRuntime(options);
