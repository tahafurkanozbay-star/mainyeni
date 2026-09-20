import { createKeyboardCommandRuntime, normalizeShortcut } from "./keyboardCommandRuntime";

const press = (target: HTMLElement | Document, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe("shortcut normalization", () => {
    test("normalizes modifier order and aliases", () => {
        expect(normalizeShortcut("shift+ctrl+K")).toBe("Ctrl+Shift+k");
        expect(normalizeShortcut("cmd+esc")).toBe("Meta+Escape");
        expect(normalizeShortcut("option+return")).toBe("Alt+Enter");
    });

    test("normalizes multi-chord sequences", () => {
        expect(normalizeShortcut("Ctrl+K   Ctrl+P")).toBe("Ctrl+k Ctrl+p");
    });
});

describe("KeyboardCommandRuntime registration", () => {
    test("registers and unregisters commands", () => {
        const runtime = createKeyboardCommandRuntime({ target: document });
        const dispose = runtime.register({ id: "palette", keys: "Ctrl+K", label: "Palet", handler: vi.fn() });
        expect(runtime.snapshot().commandCount).toBe(1);
        dispose();
        expect(runtime.snapshot().commandCount).toBe(0);
        runtime.destroy();
    });

    test("rejects blank ids, blank shortcuts and duplicates", () => {
        const runtime = createKeyboardCommandRuntime({ target: document });
        expect(() => runtime.register({ id: " ", keys: "x", label: "X", handler: vi.fn() })).toThrow(/id/);
        expect(() => runtime.register({ id: "empty", keys: " ", label: "X", handler: vi.fn() })).toThrow(/shortcut/);
        runtime.register({ id: "same", keys: "x", label: "X", handler: vi.fn() });
        expect(() => runtime.register({ id: "same", keys: "y", label: "Y", handler: vi.fn() })).toThrow(/kayıtlı/);
        runtime.destroy();
    });
});

describe("KeyboardCommandRuntime execution", () => {
    test("executes matching global shortcut and prevents default", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "palette", keys: "Ctrl+K", label: "Palet", handler });
        const event = press(document, "k", { ctrlKey: true });
        expect(event.defaultPrevented).toBe(true);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ commandId: "palette", sequence: "Ctrl+k", scope: "global" }));
        runtime.destroy();
    });

    test("supports multiple shortcuts for one command", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "search", keys: ["Ctrl+F", "/"], label: "Ara", handler });
        press(document, "/");
        press(document, "f", { ctrlKey: true });
        expect(handler).toHaveBeenCalledTimes(2);
        runtime.destroy();
    });

    test("honors preventDefault false and stopPropagation true", () => {
        const runtime = createKeyboardCommandRuntime({ target: document });
        const windowListener = vi.fn();
        window.addEventListener("keydown", windowListener);
        runtime.register({ id: "help", keys: "F1", label: "Yardım", preventDefault: false, stopPropagation: true, handler: vi.fn() });
        const event = press(document.body, "F1");
        expect(event.defaultPrevented).toBe(false);
        expect(windowListener).not.toHaveBeenCalled();
        window.removeEventListener("keydown", windowListener);
        runtime.destroy();
    });

    test("ignores already-consumed and composing events", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "x", keys: "x", label: "X", handler });
        const consumed = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
        consumed.preventDefault();
        document.dispatchEvent(consumed);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, isComposing: true }));
        expect(handler).not.toHaveBeenCalled();
        runtime.destroy();
    });

    test("does not execute disabled commands", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "x", keys: "x", label: "X", enabled: () => false, handler });
        press(document, "x");
        expect(handler).not.toHaveBeenCalled();
        runtime.destroy();
    });
});

describe("editable target safety", () => {
    test("does not steal typing from text inputs by default", () => {
        document.body.innerHTML = '<input id="query" />';
        const input = document.querySelector("#query") as HTMLInputElement;
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "x", keys: "x", label: "X", handler });
        press(input, "x");
        expect(handler).not.toHaveBeenCalled();
        runtime.destroy();
    });

    test("can explicitly allow shortcuts in editable controls", () => {
        document.body.innerHTML = '<textarea id="notes"></textarea>';
        const textarea = document.querySelector("#notes") as HTMLTextAreaElement;
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "save", keys: "Ctrl+S", label: "Kaydet", allowInEditable: true, handler });
        press(textarea, "s", { ctrlKey: true });
        expect(handler).toHaveBeenCalledTimes(1);
        runtime.destroy();
    });

    test("allows shortcuts from non-text input controls", () => {
        document.body.innerHTML = '<input id="toggle" type="checkbox" />';
        const checkbox = document.querySelector("#toggle") as HTMLInputElement;
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "x", keys: "x", label: "X", handler });
        press(checkbox, "x");
        expect(handler).toHaveBeenCalledTimes(1);
        runtime.destroy();
    });
});

describe("scope arbitration", () => {
    test("prefers the top active scope over global", () => {
        const calls: string[] = [];
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "global-escape", keys: "Escape", label: "Global", handler: () => calls.push("global") });
        runtime.register({ id: "overlay-escape", keys: "Escape", label: "Overlay", scope: "overlay", handler: () => calls.push("overlay") });
        const pop = runtime.pushScope("overlay");
        press(document, "Escape");
        pop();
        press(document, "Escape");
        expect(calls).toEqual(["overlay", "global"]);
        runtime.destroy();
    });

    test("priority resolves conflicts inside the same scope", () => {
        const calls: string[] = [];
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "low", keys: "x", label: "Low", priority: 1, handler: () => calls.push("low") });
        runtime.register({ id: "high", keys: "x", label: "High", priority: 10, handler: () => calls.push("high") });
        press(document, "x");
        expect(calls).toEqual(["high"]);
        runtime.destroy();
    });

    test("scope disposer is idempotent", () => {
        const runtime = createKeyboardCommandRuntime({ target: document });
        const pop = runtime.pushScope("map");
        expect(runtime.snapshot().activeScopes).toEqual(["global", "map"]);
        pop();
        pop();
        expect(runtime.snapshot().activeScopes).toEqual(["global"]);
        runtime.destroy();
    });

    test("setScope replaces non-global scopes", () => {
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.pushScope("map");
        runtime.pushScope("overlay");
        runtime.setScope("navigation");
        expect(runtime.snapshot().activeScopes).toEqual(["global", "navigation"]);
        runtime.destroy();
    });
});

describe("multi-chord sequences", () => {
    beforeEach(() => vi.useFakeTimers());

    test("executes a complete two-chord command", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document, sequenceTimeoutMs: 300 });
        runtime.register({ id: "layers", keys: "g l", label: "Katmanlar", handler });
        press(document, "g");
        expect(runtime.snapshot().pendingSequence).toBe("g");
        press(document, "l");
        expect(handler).toHaveBeenCalledTimes(1);
        expect(runtime.snapshot().pendingSequence).toBe("");
        runtime.destroy();
    });

    test("resets an unmatched prefix and retries the current chord", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "layers", keys: "g l", label: "Katmanlar", handler: vi.fn() });
        runtime.register({ id: "search", keys: "/", label: "Ara", handler });
        press(document, "g");
        press(document, "/");
        expect(handler).toHaveBeenCalledTimes(1);
        runtime.destroy();
    });

    test("waits when a chord is both exact and a longer prefix", () => {
        const calls: string[] = [];
        const runtime = createKeyboardCommandRuntime({ target: document, sequenceTimeoutMs: 200 });
        runtime.register({ id: "g", keys: "g", label: "G", handler: () => calls.push("g") });
        runtime.register({ id: "gl", keys: "g l", label: "GL", handler: () => calls.push("gl") });
        press(document, "g");
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(200);
        expect(calls).toEqual(["g"]);
        runtime.destroy();
    });
});

describe("error isolation and cleanup", () => {
    test("reports synchronous handler errors", () => {
        const onError = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document, onError });
        runtime.register({ id: "bad", keys: "b", label: "Bad", handler: () => { throw new Error("boom"); } });
        press(document, "b");
        expect(onError).toHaveBeenCalledWith(expect.any(Error), "bad");
        runtime.destroy();
    });

    test("reports asynchronous handler errors", async () => {
        const onError = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document, onError });
        runtime.register({ id: "bad", keys: "b", label: "Bad", handler: async () => { throw new Error("boom"); } });
        press(document, "b");
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledWith(expect.any(Error), "bad");
        runtime.destroy();
    });

    test("destroy removes listener and clears registry", () => {
        const handler = vi.fn();
        const runtime = createKeyboardCommandRuntime({ target: document });
        runtime.register({ id: "x", keys: "x", label: "X", handler });
        runtime.destroy();
        press(document, "x");
        expect(handler).not.toHaveBeenCalled();
        expect(runtime.snapshot().commandCount).toBe(0);
        expect(() => runtime.register({ id: "y", keys: "y", label: "Y", handler })).toThrow(/destroy/);
    });
});
