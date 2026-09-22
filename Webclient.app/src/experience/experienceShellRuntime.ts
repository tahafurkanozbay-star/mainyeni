import {
  createAccessibilityPreferencesRuntime,
  type AccessibilityPreferencesRuntime,
  type AccessibilityPreferencesSnapshot,
} from "./accessibilityPreferences";
import {
  createInteractionModalityRuntime,
  type InteractionModalityRuntime,
  type InteractionModalitySnapshot,
} from "./interactionModality";
import {
  createKeyboardShortcutRuntime,
  type KeyboardShortcutRuntime,
  type ShortcutRuntimeSnapshot,
  type ShortcutScope,
} from "./keyboardShortcutRuntime";
import {
  createResponsiveWorkspaceRuntime,
  type WorkspaceMetrics,
  type WorkspaceRuntime,
  type WorkspaceSnapshot,
} from "./responsiveWorkspace";

export interface ExperienceShellSnapshot {
  readonly accessibility: Readonly<AccessibilityPreferencesSnapshot>;
  readonly modality: Readonly<InteractionModalitySnapshot>;
  readonly shortcuts: Readonly<ShortcutRuntimeSnapshot>;
  readonly workspace: Readonly<WorkspaceSnapshot>;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

export interface ExperienceShellRuntimeOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly initialMapMode?: "2d" | "3d";
  readonly mapSelector?: string;
  readonly panelSelector?: string;
  readonly dialogSelector?: string;
  readonly reflectToDocument?: boolean;
  readonly onError?: (error: unknown, source: ExperienceShellErrorSource) => void;
}

export type ExperienceShellErrorSource =
  | "accessibility"
  | "modality"
  | "shortcut"
  | "workspace"
  | "observer";

export type ExperienceShellListener = (
  snapshot: Readonly<ExperienceShellSnapshot>,
  previous: Readonly<ExperienceShellSnapshot>,
) => void;

interface VisualViewportLike extends EventTarget {
  readonly width: number;
  readonly height: number;
  readonly offsetTop: number;
  readonly offsetLeft: number;
}

const DEFAULT_MAP_SELECTOR = "#esri-map-container";
const DEFAULT_PANEL_SELECTOR = "#sidebar, [data-experience-panel]";
const DEFAULT_DIALOG_SELECTOR = "[role='dialog'], [aria-modal='true']";

const finiteNonNegative = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

const cloneSnapshot = (value: ExperienceShellSnapshot): ExperienceShellSnapshot =>
  Object.freeze({
    accessibility: Object.freeze({ ...value.accessibility }),
    modality: Object.freeze({ ...value.modality }),
    shortcuts: Object.freeze({ ...value.shortcuts }),
    workspace: value.workspace,
    width: value.width,
    height: value.height,
    revision: value.revision,
  });

const resolveVisualViewport = (runtimeWindow: Window): VisualViewportLike | null => {
  const candidate = runtimeWindow.visualViewport;
  if (!candidate) return null;
  return candidate as unknown as VisualViewportLike;
};

const readMetrics = (
  runtimeWindow: Window,
  accessibility: Readonly<AccessibilityPreferencesSnapshot>,
): WorkspaceMetrics => {
  const visual = resolveVisualViewport(runtimeWindow);
  const width = finiteNonNegative(runtimeWindow.innerWidth);
  const height = finiteNonNegative(runtimeWindow.innerHeight);
  const visualWidth = visual ? finiteNonNegative(visual.width, width) : width;
  const visualHeight = visual ? finiteNonNegative(visual.height, height) : height;
  const keyboardInset = height > visualHeight && height - visualHeight >= 80
    ? Math.round(height - visualHeight)
    : 0;
  return {
    width,
    height,
    visualWidth,
    visualHeight,
    keyboardInset,
    coarsePointer: accessibility.pointer === "coarse",
    hover: accessibility.hoverCapable,
    reducedMotion: accessibility.reducedMotion,
  };
};

const closestMatches = (target: EventTarget | null, selector: string): boolean =>
  target instanceof Element && target.closest(selector) !== null;

export class ExperienceShellRuntime {
  private readonly runtimeWindow: Window;
  private readonly runtimeDocument: Document;
  private readonly reflectToDocument: boolean;
  private readonly mapSelector: string;
  private readonly panelSelector: string;
  private readonly dialogSelector: string;
  private readonly onError: ExperienceShellRuntimeOptions["onError"];
  private readonly accessibilityRuntime: AccessibilityPreferencesRuntime;
  private readonly modalityRuntime: InteractionModalityRuntime;
  private readonly shortcutRuntime: KeyboardShortcutRuntime;
  private readonly workspaceRuntime: WorkspaceRuntime;
  private readonly listeners = new Set<ExperienceShellListener>();
  private readonly releases: Array<() => void> = [];
  private snapshotValue: ExperienceShellSnapshot;
  private revision = 0;
  private disposed = false;
  private resizeFrame = 0;

  constructor(options: ExperienceShellRuntimeOptions = {}) {
    const runtimeWindow = options.window ?? globalThis.window;
    const runtimeDocument = options.document ?? runtimeWindow?.document ?? globalThis.document;
    if (!runtimeWindow || !runtimeDocument) throw new Error("ExperienceShellRuntime browser Window ve Document gerektirir.");

    this.runtimeWindow = runtimeWindow;
    this.runtimeDocument = runtimeDocument;
    this.reflectToDocument = options.reflectToDocument ?? true;
    this.mapSelector = options.mapSelector ?? DEFAULT_MAP_SELECTOR;
    this.panelSelector = options.panelSelector ?? DEFAULT_PANEL_SELECTOR;
    this.dialogSelector = options.dialogSelector ?? DEFAULT_DIALOG_SELECTOR;
    this.onError = options.onError;

    this.accessibilityRuntime = createAccessibilityPreferencesRuntime({
      window: runtimeWindow,
      document: runtimeDocument,
      reflectToDocument: this.reflectToDocument,
      applyColorScheme: false,
      onObserverError: (error) => this.report(error, "accessibility"),
    });
    this.modalityRuntime = createInteractionModalityRuntime({
      document: runtimeDocument,
      reflectToDocument: this.reflectToDocument,
      onError: (error) => this.report(error, "modality"),
    });
    this.shortcutRuntime = createKeyboardShortcutRuntime({
      document: runtimeDocument,
      initialScope: "global",
      onError: (error) => this.report(error, "shortcut"),
    });
    this.workspaceRuntime = createResponsiveWorkspaceRuntime({
      initialMetrics: readMetrics(runtimeWindow, this.accessibilityRuntime.snapshot),
      initialState: { mapMode: options.initialMapMode ?? "2d" },
      onError: (error) => this.report(error, "workspace"),
    });

    const size = this.readSize();
    this.snapshotValue = this.buildSnapshot(size.width, size.height);
    this.installRuntimeObservers();
    this.installShortcuts();
    this.reflect(this.snapshotValue);
  }

  get snapshot(): Readonly<ExperienceShellSnapshot> { return cloneSnapshot(this.snapshotValue); }
  get isDisposed(): boolean { return this.disposed; }

  subscribe(listener: ExperienceShellListener, emitCurrent = false): () => void {
    this.assertActive();
    this.listeners.add(listener);
    if (emitCurrent) {
      const current = this.snapshot;
      this.notifyOne(listener, current, current);
    }
    return () => { this.listeners.delete(listener); };
  }

  setMapMode(mode: "2d" | "3d"): Readonly<ExperienceShellSnapshot> {
    this.assertActive();
    this.workspaceRuntime.setMapMode(mode);
    return this.refreshSnapshot();
  }

  setShortcutScope(scope: ShortcutScope): Readonly<ExperienceShellSnapshot> {
    this.assertActive();
    this.shortcutRuntime.setScope(scope);
    return this.refreshSnapshot();
  }

  refresh(): Readonly<ExperienceShellSnapshot> {
    this.assertActive();
    this.accessibilityRuntime.refresh();
    this.workspaceRuntime.setMetrics(readMetrics(this.runtimeWindow, this.accessibilityRuntime.snapshot));
    return this.refreshSnapshot();
  }

  focusMap(): boolean { this.assertActive(); return this.focusSelector(this.mapSelector); }
  focusPanel(): boolean { this.assertActive(); return this.focusSelector(this.panelSelector); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeFrame) {
      this.runtimeWindow.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = 0;
    }
    for (const release of this.releases.splice(0)) {
      try { release(); } catch (error) { this.report(error, "observer"); }
    }
    this.listeners.clear();
    this.shortcutRuntime.dispose();
    this.workspaceRuntime.dispose();
    this.modalityRuntime.dispose();
    this.accessibilityRuntime.dispose();
    this.clearReflection();
  }

  private installRuntimeObservers(): void {
    this.releases.push(
      this.accessibilityRuntime.subscribe(() => {
        this.workspaceRuntime.setMetrics(readMetrics(this.runtimeWindow, this.accessibilityRuntime.snapshot));
        this.refreshSnapshot();
      }),
      this.modalityRuntime.subscribe(() => this.refreshSnapshot()),
      this.shortcutRuntime.subscribe(() => this.refreshSnapshot()),
      this.workspaceRuntime.subscribe(() => this.refreshSnapshot()),
    );

    const onResize = (): void => {
      if (this.resizeFrame) this.runtimeWindow.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = this.runtimeWindow.requestAnimationFrame(() => {
        this.resizeFrame = 0;
        if (this.disposed) return;
        this.workspaceRuntime.setMetrics(readMetrics(this.runtimeWindow, this.accessibilityRuntime.snapshot));
        this.refreshSnapshot();
      });
    };
    this.runtimeWindow.addEventListener("resize", onResize, { passive: true });
    this.releases.push(() => this.runtimeWindow.removeEventListener("resize", onResize));

    const visual = resolveVisualViewport(this.runtimeWindow);
    if (visual) {
      visual.addEventListener("resize", onResize);
      visual.addEventListener("scroll", onResize);
      this.releases.push(() => {
        visual.removeEventListener("resize", onResize);
        visual.removeEventListener("scroll", onResize);
      });
    }

    const onFocusIn = (event: FocusEvent): void => {
      const scope = this.resolveScope(event.target);
      if (this.shortcutRuntime.snapshot.scope !== scope) this.shortcutRuntime.setScope(scope);
    };
    this.runtimeDocument.addEventListener("focusin", onFocusIn, true);
    this.releases.push(() => this.runtimeDocument.removeEventListener("focusin", onFocusIn, true));
  }

  private installShortcuts(): void {
    this.releases.push(
      this.shortcutRuntime.register({ id: "experience-focus-map", key: "m", alt: true, preventDefault: true, run: () => { this.focusSelector(this.mapSelector); } }),
      this.shortcutRuntime.register({ id: "experience-focus-panel", key: "s", alt: true, preventDefault: true, run: () => { this.focusSelector(this.panelSelector); } }),
    );
  }

  private resolveScope(target: EventTarget | null): ShortcutScope {
    if (closestMatches(target, this.dialogSelector)) return "dialog";
    if (closestMatches(target, this.panelSelector)) return "panel";
    if (closestMatches(target, this.mapSelector)) return "map";
    return "global";
  }

  private focusSelector(selector: string): boolean {
    let node: Element | null;
    try { node = this.runtimeDocument.querySelector(selector); }
    catch (error) { this.report(error, "shortcut"); return false; }
    if (!(node instanceof HTMLElement)) return false;
    if (node.tabIndex < 0 && !node.hasAttribute("tabindex")) {
      node.tabIndex = -1;
      node.dataset.experienceTemporaryTabindex = "true";
    }
    try {
      node.focus({ preventScroll: true });
      return this.runtimeDocument.activeElement === node;
    } catch (error) { this.report(error, "shortcut"); return false; }
  }

  private readSize(): { width: number; height: number } {
    const visual = resolveVisualViewport(this.runtimeWindow);
    return {
      width: visual ? finiteNonNegative(visual.width, finiteNonNegative(this.runtimeWindow.innerWidth)) : finiteNonNegative(this.runtimeWindow.innerWidth),
      height: visual ? finiteNonNegative(visual.height, finiteNonNegative(this.runtimeWindow.innerHeight)) : finiteNonNegative(this.runtimeWindow.innerHeight),
    };
  }

  private buildSnapshot(width: number, height: number): ExperienceShellSnapshot {
    return Object.freeze({ accessibility: this.accessibilityRuntime.snapshot, modality: this.modalityRuntime.snapshot, shortcuts: this.shortcutRuntime.snapshot, workspace: this.workspaceRuntime.getSnapshot(), width, height, revision: this.revision });
  }

  private refreshSnapshot(): Readonly<ExperienceShellSnapshot> {
    if (this.disposed) return this.snapshotValue;
    const previous = this.snapshotValue;
    const size = this.readSize();
    const candidate = this.buildSnapshot(size.width, size.height);
    if (this.equivalent(previous, candidate)) return this.snapshotValue;
    this.revision += 1;
    this.snapshotValue = Object.freeze({ ...candidate, revision: this.revision });
    this.reflect(this.snapshotValue);
    const next = this.snapshot;
    const prior = cloneSnapshot(previous);
    for (const listener of this.listeners) this.notifyOne(listener, next, prior);
    return next;
  }

  private equivalent(left: ExperienceShellSnapshot, right: ExperienceShellSnapshot): boolean {
    return left.width === right.width && left.height === right.height
      && left.accessibility.revision === right.accessibility.revision
      && left.modality.revision === right.modality.revision
      && left.shortcuts.revision === right.shortcuts.revision
      && left.workspace.policy.viewport === right.workspace.policy.viewport
      && left.workspace.policy.placement === right.workspace.policy.placement
      && left.workspace.policy.inputMode === right.workspace.policy.inputMode
      && left.workspace.policy.touchTarget === right.workspace.policy.touchTarget
      && left.workspace.policy.keyboardInset === right.workspace.policy.keyboardInset
      && left.workspace.state.mapMode === right.workspace.state.mapMode
      && left.workspace.state.activePanel === right.workspace.state.activePanel
      && left.workspace.state.panelPinned === right.workspace.state.panelPinned;
  }

  private reflect(snapshot: ExperienceShellSnapshot): void {
    if (!this.reflectToDocument) return;
    const root = this.runtimeDocument.documentElement;
    root.dataset.experienceViewport = snapshot.workspace.policy.viewport;
    root.dataset.experiencePlacement = snapshot.workspace.policy.placement;
    root.dataset.experienceInput = snapshot.workspace.policy.inputMode;
    root.dataset.experienceMapMode = snapshot.workspace.state.mapMode;
    root.style.setProperty("--experience-touch-target", `${snapshot.workspace.policy.touchTarget}px`);
    root.style.setProperty("--experience-panel-width", `${snapshot.workspace.policy.panelWidth}px`);
    root.style.setProperty("--experience-panel-max-height", `${snapshot.workspace.policy.panelMaxHeight}px`);
    root.style.setProperty("--experience-keyboard-inset", `${snapshot.workspace.policy.keyboardInset}px`);
  }

  private clearReflection(): void {
    if (!this.reflectToDocument) return;
    const root = this.runtimeDocument.documentElement;
    delete root.dataset.experienceViewport;
    delete root.dataset.experiencePlacement;
    delete root.dataset.experienceInput;
    delete root.dataset.experienceMapMode;
    root.style.removeProperty("--experience-touch-target");
    root.style.removeProperty("--experience-panel-width");
    root.style.removeProperty("--experience-panel-max-height");
    root.style.removeProperty("--experience-keyboard-inset");
    for (const node of this.runtimeDocument.querySelectorAll<HTMLElement>("[data-experience-temporary-tabindex='true']")) {
      node.removeAttribute("tabindex");
      delete node.dataset.experienceTemporaryTabindex;
    }
  }

  private notifyOne(listener: ExperienceShellListener, snapshot: Readonly<ExperienceShellSnapshot>, previous: Readonly<ExperienceShellSnapshot>): void {
    try { listener(snapshot, previous); } catch (error) { this.report(error, "observer"); }
  }

  private report(error: unknown, source: ExperienceShellErrorSource): void {
    if (!this.onError) { queueMicrotask(() => { throw error; }); return; }
    try { this.onError(error, source); }
    catch (reportingError) { queueMicrotask(() => { throw reportingError; }); }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ExperienceShellRuntime dispose edildikten sonra kullanılamaz.");
  }
}

export const createExperienceShellRuntime = (options: ExperienceShellRuntimeOptions = {}): ExperienceShellRuntime => new ExperienceShellRuntime(options);
