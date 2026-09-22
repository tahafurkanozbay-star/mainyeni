import { createExperienceShellRuntime } from "./experienceShellRuntime";

class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  matches = false;
  readonly media: string;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
  constructor(media: string) { super(); this.media = media; }
  setMatches(matches: boolean): void {
    if (this.matches === matches) return;
    this.matches = matches;
    const event = new Event("change") as MediaQueryListEvent;
    Object.defineProperty(event, "matches", { value: matches });
    Object.defineProperty(event, "media", { value: this.media });
    this.dispatchEvent(event);
    this.onchange?.call(this, event);
  }
  addListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void { if (callback) this.addEventListener("change", callback as EventListener); }
  removeListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void { if (callback) this.removeEventListener("change", callback as EventListener); }
}
class FakeVisualViewport extends EventTarget { width = 1200; height = 800; offsetTop = 0; offsetLeft = 0; }

const installMatchMedia = () => {
  const queries = new Map<string, FakeMediaQueryList>();
  const matchMedia = vi.fn((query: string): MediaQueryList => {
    let item = queries.get(query);
    if (!item) {
      item = new FakeMediaQueryList(query);
      if (query === "(pointer: fine)" || query === "(hover: hover)") item.matches = true;
      queries.set(query, item);
    }
    return item;
  });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
  return queries;
};
const setWindowSize = (width: number, height: number): void => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
};
const installAnimationFrame = (): void => {
  let id = 0;
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { id += 1; callback(performance.now()); return id; } });
  Object.defineProperty(window, "cancelAnimationFrame", { configurable: true, value: vi.fn() });
};
const key = (value: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  for (const keyName of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[keyName];
  setWindowSize(1200, 800);
  installMatchMedia();
  installAnimationFrame();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
});
afterEach(() => { document.body.replaceChildren(); });

describe("ExperienceShellRuntime", () => {
  test("composes accessibility, modality, shortcuts and responsive workspace", () => {
    const runtime = createExperienceShellRuntime({ window, document });
    expect(runtime.snapshot.workspace.policy.viewport).toBe("wide");
    expect(runtime.snapshot.workspace.policy.placement).toBe("side");
    expect(runtime.snapshot.shortcuts.registered).toBe(2);
    expect(runtime.snapshot.modality.modality).toBe("programmatic");
    expect(runtime.snapshot.accessibility.reducedMotion).toBe(false);
    runtime.dispose();
  });
  test("reflects adaptive state to the document root", () => {
    const runtime = createExperienceShellRuntime({ window, document });
    expect(document.documentElement.dataset.experienceViewport).toBe("wide");
    expect(document.documentElement.dataset.experiencePlacement).toBe("side");
    expect(document.documentElement.dataset.experienceInput).toBe("pointer");
    expect(document.documentElement.style.getPropertyValue("--experience-touch-target")).toBe("36px");
    runtime.dispose();
  });
  test("focuses map with Alt+M", () => {
    const map = document.createElement("main"); map.id = "esri-map-container"; document.body.append(map);
    const runtime = createExperienceShellRuntime({ window, document });
    const event = key("m", { altKey: true });
    expect(event.defaultPrevented).toBe(true); expect(document.activeElement).toBe(map); expect(map.tabIndex).toBe(-1);
    runtime.dispose(); expect(map.hasAttribute("tabindex")).toBe(false);
  });
  test("focuses panel with Alt+S", () => {
    const panel = document.createElement("aside"); panel.id = "sidebar"; panel.tabIndex = 0; document.body.append(panel);
    const runtime = createExperienceShellRuntime({ window, document }); key("s", { altKey: true }); expect(document.activeElement).toBe(panel); runtime.dispose();
  });
  test("does not steal plain letter shortcuts", () => {
    const map = document.createElement("main"); map.id = "esri-map-container"; document.body.append(map);
    const runtime = createExperienceShellRuntime({ window, document }); const event = key("m"); expect(event.defaultPrevented).toBe(false); expect(document.activeElement).not.toBe(map); runtime.dispose();
  });
  test("tracks focused map scope", () => {
    const map = document.createElement("button"); map.id = "esri-map-container"; document.body.append(map);
    const runtime = createExperienceShellRuntime({ window, document }); map.focus(); expect(runtime.snapshot.shortcuts.scope).toBe("map"); runtime.dispose();
  });
  test("tracks focused panel scope", () => {
    const panel = document.createElement("aside"); panel.id = "sidebar"; const button = document.createElement("button"); panel.append(button); document.body.append(panel);
    const runtime = createExperienceShellRuntime({ window, document }); button.focus(); expect(runtime.snapshot.shortcuts.scope).toBe("panel"); runtime.dispose();
  });
  test("dialog scope has priority over nested panel scope", () => {
    const panel = document.createElement("aside"); panel.id = "sidebar"; const dialog = document.createElement("section"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); const button = document.createElement("button"); dialog.append(button); panel.append(dialog); document.body.append(panel);
    const runtime = createExperienceShellRuntime({ window, document }); button.focus(); expect(runtime.snapshot.shortcuts.scope).toBe("dialog"); runtime.dispose();
  });
  test("recomputes compact bottom sheet policy after resize", () => {
    const runtime = createExperienceShellRuntime({ window, document }); setWindowSize(520, 760); window.dispatchEvent(new Event("resize")); expect(runtime.snapshot.workspace.policy.viewport).toBe("compact"); expect(runtime.snapshot.workspace.policy.placement).toBe("bottom-sheet"); runtime.dispose();
  });
  test("uses visual viewport to detect virtual keyboard inset", () => {
    const visual = new FakeVisualViewport(); visual.width = 390; visual.height = 460; setWindowSize(390, 760); Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    const runtime = createExperienceShellRuntime({ window, document }); expect(runtime.snapshot.workspace.policy.keyboardInset).toBe(300); expect(document.documentElement.style.getPropertyValue("--experience-keyboard-inset")).toBe("300px"); runtime.dispose();
  });
  test("updates when visual viewport changes", () => {
    const visual = new FakeVisualViewport(); visual.width = 1000; visual.height = 700; setWindowSize(1200, 800); Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    const runtime = createExperienceShellRuntime({ window, document }); expect(runtime.snapshot.workspace.policy.viewport).toBe("medium"); visual.width = 600; visual.dispatchEvent(new Event("resize")); expect(runtime.snapshot.workspace.policy.viewport).toBe("compact"); runtime.dispose();
  });
  test("propagates reduced motion into workspace transition policy", () => {
    const media = installMatchMedia(); const runtime = createExperienceShellRuntime({ window, document }); media.get("(prefers-reduced-motion: reduce)")?.setMatches(true); expect(runtime.snapshot.accessibility.reducedMotion).toBe(true); expect(runtime.snapshot.workspace.policy.transitionMs).toBe(0); runtime.dispose();
  });
  test("propagates coarse pointer and hover capabilities", () => {
    const media = installMatchMedia(); const coarse = media.get("(pointer: coarse)") ?? new FakeMediaQueryList("(pointer: coarse)"); const hover = media.get("(hover: hover)") ?? new FakeMediaQueryList("(hover: hover)"); media.set("(pointer: coarse)", coarse); media.set("(hover: hover)", hover);
    const runtime = createExperienceShellRuntime({ window, document }); coarse.setMatches(true); hover.setMatches(false); expect(runtime.snapshot.workspace.policy.inputMode).toBe("touch"); expect(runtime.snapshot.workspace.policy.touchTarget).toBe(44); runtime.dispose();
  });
  test("supports explicit map mode changes", () => {
    const runtime = createExperienceShellRuntime({ window, document }); runtime.setMapMode("3d"); expect(runtime.snapshot.workspace.state.mapMode).toBe("3d"); expect(document.documentElement.dataset.experienceMapMode).toBe("3d"); runtime.setMapMode("2d"); runtime.dispose();
  });
  test("notifies observers only for meaningful snapshot transitions", () => {
    const runtime = createExperienceShellRuntime({ window, document }); const listener = vi.fn(); runtime.subscribe(listener, true); runtime.setMapMode("3d"); runtime.setMapMode("3d"); expect(listener).toHaveBeenCalledTimes(2); runtime.dispose();
  });
  test("isolates observer failures through the shell error boundary", () => {
    const errors: Array<{ error: unknown; source: string }> = []; const runtime = createExperienceShellRuntime({ window, document, onError: (error, source) => errors.push({ error, source }) }); runtime.subscribe(() => { throw new Error("observer"); }); runtime.setMapMode("3d"); expect(errors[0]?.source).toBe("observer"); runtime.dispose();
  });
  test("returns false when requested focus target is absent", () => {
    const runtime = createExperienceShellRuntime({ window, document }); expect(runtime.focusMap()).toBe(false); expect(runtime.focusPanel()).toBe(false); runtime.dispose();
  });
  test("reports invalid selectors without breaking the shell", () => {
    const errors: string[] = []; const runtime = createExperienceShellRuntime({ window, document, mapSelector: "[", onError: (_error, source) => errors.push(source) }); expect(runtime.focusMap()).toBe(false); expect(errors).toEqual(["shortcut"]); runtime.dispose();
  });
  test("dispose removes root reflection and prevents further mutations", () => {
    const runtime = createExperienceShellRuntime({ window, document }); runtime.dispose(); expect(runtime.isDisposed).toBe(true); expect(document.documentElement.dataset.experienceViewport).toBeUndefined(); expect(() => runtime.setMapMode("3d")).toThrow(/dispose/);
  });
});
