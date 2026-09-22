import { createKeyboardShortcutRuntime } from "./keyboardShortcutRuntime";

const key = (target: HTMLElement | Document, value: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

afterEach(() => document.body.replaceChildren());

describe("KeyboardShortcutRuntime", () => {
  test("runs a matching global shortcut and prevents browser default", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "search", key: "k", ctrl: true, run });
    const event = key(document, "k", { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    runtime.dispose();
  });

  test("normalizes printable keys for Turkish locale", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "inspect", key: "İ", run });
    key(document, "İ");
    expect(run).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("does not run when modifier chord differs", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "search", key: "k", ctrl: true, run });
    key(document, "k");
    expect(run).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test("honors preventDefault false", () => {
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "help", key: "?", preventDefault: false, run: vi.fn() });
    const event = key(document, "?");
    expect(event.defaultPrevented).toBe(false);
    runtime.dispose();
  });

  test("scopes map shortcuts away from dialogs", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document, initialScope: "dialog" });
    runtime.register({ id: "map-home", key: "h", scope: "map", run });
    key(document, "h");
    expect(run).not.toHaveBeenCalled();
    runtime.setScope("map");
    key(document, "h");
    expect(run).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("keeps global shortcuts active in specialized scopes", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document, initialScope: "panel" });
    runtime.register({ id: "escape-help", key: "F1", run });
    key(document, "F1");
    expect(run).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("blocks shortcuts in editable controls by default", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "letter", key: "a", run });
    key(input, "a");
    expect(run).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test("can explicitly allow shortcuts in editable controls", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "escape", key: "Escape", allowInEditable: true, run });
    key(textarea, "Escape");
    expect(run).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("honors dynamic enabled predicates", () => {
    let enabled = false;
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "zoom", key: "+", enabled: () => enabled, run });
    key(document, "+");
    expect(run).not.toHaveBeenCalled();
    enabled = true;
    key(document, "+");
    expect(run).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("returns unregister cleanup from registration", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    const unregister = runtime.register({ id: "layers", key: "l", run });
    unregister();
    key(document, "l");
    expect(run).not.toHaveBeenCalled();
    expect(runtime.snapshot.registered).toBe(0);
    runtime.dispose();
  });

  test("rejects duplicate ids", () => {
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "layers", key: "l", run: vi.fn() });
    expect(() => runtime.register({ id: "layers", key: "x", run: vi.fn() })).toThrow(/zaten kayıtlı/);
    runtime.dispose();
  });

  test("replace updates an existing definition without growing registry", () => {
    const oldRun = vi.fn();
    const newRun = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "layers", key: "l", run: oldRun });
    runtime.replace({ id: "layers", key: "x", run: newRun });
    key(document, "l");
    key(document, "x");
    expect(oldRun).not.toHaveBeenCalled();
    expect(newRun).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot.registered).toBe(1);
    runtime.dispose();
  });

  test("list returns copies rather than mutable registry objects", () => {
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "layers", key: "l", run: vi.fn() });
    const listed = runtime.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("layers");
    runtime.dispose();
  });

  test("emits immutable snapshot transitions", () => {
    const listener = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.subscribe(listener, true);
    runtime.register({ id: "layers", key: "l", run: vi.fn() });
    runtime.setScope("map");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(runtime.snapshot).toMatchObject({ scope: "map", registered: 1, enabled: 1 });
    expect(runtime.snapshot.revision).toBe(2);
    runtime.dispose();
  });

  test("isolates observer failures through onError", () => {
    const errors: Array<{ error: unknown; id: string }> = [];
    const healthy = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document, onError: (error, id) => errors.push({ error, id }) });
    runtime.subscribe(() => { throw new Error("observer failed"); });
    runtime.subscribe(healthy);
    runtime.register({ id: "layers", key: "l", run: vi.fn() });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("observer");
    expect(healthy).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("reports handler failures without breaking later keyboard events", () => {
    const errors: string[] = [];
    const healthy = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document, onError: (_error, id) => errors.push(id) });
    runtime.register({ id: "broken", key: "b", run: () => { throw new Error("boom"); } });
    runtime.register({ id: "healthy", key: "h", run: healthy });
    key(document, "b");
    key(document, "h");
    expect(errors).toEqual(["broken"]);
    expect(healthy).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test("reports enabled predicate failures and treats shortcut as disabled", () => {
    const errors: string[] = [];
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document, onError: (_error, id) => errors.push(id) });
    runtime.register({ id: "broken-enabled", key: "b", enabled: () => { throw new Error("boom"); }, run });
    key(document, "b");
    expect(run).not.toHaveBeenCalled();
    expect(errors).toContain("broken-enabled");
    runtime.dispose();
  });

  test("ignores already prevented keyboard events", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "layers", key: "l", run });
    const event = new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(run).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test("dispose removes the document listener and rejects further mutations", () => {
    const run = vi.fn();
    const runtime = createKeyboardShortcutRuntime({ document });
    runtime.register({ id: "layers", key: "l", run });
    runtime.dispose();
    key(document, "l");
    expect(run).not.toHaveBeenCalled();
    expect(() => runtime.setScope("map")).toThrow(/dispose/);
  });
});
