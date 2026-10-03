import {
  WORKSPACE_LANDMARK_DEFINITIONS,
  createWorkspaceLandmarkInventory,
  workspaceLandmarkInventoryChanged,
  type WorkspaceLandmarkDefinition,
  type WorkspaceLandmarkInventorySnapshot,
  type WorkspaceLandmarkObservation,
} from './workspaceLandmarkInventoryModel';

export interface WorkspaceLandmarkRuntimeOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly definitions?: readonly WorkspaceLandmarkDefinition[];
  readonly maxListeners?: number;
  readonly onError?: (error: unknown) => void;
}

type Listener = () => void;

const DEFAULT_LISTENER_LIMIT = 32;
const MAX_LISTENER_LIMIT = 128;
const NATIVE_FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'iframe']);

const clampListenerLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_LISTENER_LIMIT;
  return Math.min(MAX_LISTENER_LIMIT, Math.max(1, Math.trunc(value ?? DEFAULT_LISTENER_LIMIT)));
};

const hasText = (value: string | null | undefined): boolean => Boolean(value?.replace(/\s+/gu, ' ').trim());

const isDisabled = (element: Element): boolean => {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  if (element.hasAttribute('inert')) return true;
  return element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLFieldSetElement
    ? element.disabled
    : false;
};

const hasAccessibleName = (element: Element, doc: Document): boolean => {
  if (hasText(element.getAttribute('aria-label'))) return true;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const token of labelledBy.split(/\s+/u).filter(Boolean).slice(0, 8)) {
      const label = doc.getElementById(token);
      if (label && hasText(label.textContent)) return true;
    }
  }
  if (element instanceof HTMLInputElement) {
    if (hasText(element.labels?.[0]?.textContent)) return true;
    if (hasText(element.placeholder)) return true;
    if (element.type === 'hidden') return false;
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    if (hasText(element.labels?.[0]?.textContent)) return true;
  }
  if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || element instanceof HTMLElement) {
    if (hasText(element.textContent)) return true;
    if (hasText(element.getAttribute('title'))) return true;
  }
  return false;
};

const isElementVisible = (element: Element, win: Window | undefined): boolean => {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
  if (!win) return true;
  try {
    const style = win.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  } catch {
    return true;
  }
  return true;
};

const isElementFocusable = (element: Element): boolean => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
  if (isDisabled(element)) return false;
  if (element.getAttribute('tabindex') !== null) return element.tabIndex >= 0;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  const tagName = element.tagName.toLocaleLowerCase('en-US');
  if (!NATIVE_FOCUSABLE.has(tagName)) return typeof (element as HTMLElement).focus === 'function';
  if (element instanceof HTMLAnchorElement) return hasText(element.href) || element.hasAttribute('href');
  if (element instanceof HTMLInputElement) return element.type !== 'hidden';
  return true;
};

const candidatesForDefinition = (definition: WorkspaceLandmarkDefinition, doc: Document): readonly Element[] => {
  try {
    return Array.from(doc.querySelectorAll(definition.selector)).slice(0, 12);
  } catch {
    return Object.freeze([]);
  }
};

const observeDefinition = (
  definition: WorkspaceLandmarkDefinition,
  doc: Document,
  win: Window | undefined,
): WorkspaceLandmarkObservation => {
  const candidates = candidatesForDefinition(definition, doc);
  const visible = candidates.find((candidate) => isElementVisible(candidate, win));
  const target = visible ?? candidates[0] ?? null;
  if (!target) {
    return Object.freeze({
      id: definition.id,
      present: false,
      visible: false,
      focusable: false,
      labelled: false,
      disabled: false,
    });
  }
  const targetVisible = isElementVisible(target, win);
  const disabled = isDisabled(target);
  return Object.freeze({
    id: definition.id,
    present: true,
    visible: targetVisible,
    focusable: targetVisible && !disabled && isElementFocusable(target),
    labelled: hasAccessibleName(target, doc),
    disabled,
  });
};

const requestFrame = (win: Window | undefined, callback: FrameRequestCallback): number => {
  if (typeof win?.requestAnimationFrame === 'function') return win.requestAnimationFrame(callback);
  return -1;
};

const cancelFrame = (win: Window | undefined, frame: number): void => {
  if (frame < 0 || typeof win?.cancelAnimationFrame !== 'function') return;
  win.cancelAnimationFrame(frame);
};

export class WorkspaceLandmarkRuntime {
  private readonly doc: Document | undefined;
  private readonly win: Window | undefined;
  private readonly definitions: readonly WorkspaceLandmarkDefinition[];
  private readonly maxListeners: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly listeners = new Set<Listener>();
  private snapshot = createWorkspaceLandmarkInventory([]);
  private observer: MutationObserver | null = null;
  private frame = -1;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private started = false;
  private disposed = false;

  constructor(options: WorkspaceLandmarkRuntimeOptions = {}) {
    this.doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
    this.win = options.window ?? (typeof window === 'undefined' ? undefined : window);
    this.definitions = Object.freeze([...(options.definitions ?? WORKSPACE_LANDMARK_DEFINITIONS)].slice(0, 16));
    this.maxListeners = clampListenerLimit(options.maxListeners);
    this.onError = options.onError;
  }

  readonly getSnapshot = (): WorkspaceLandmarkInventorySnapshot => this.snapshot;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => undefined;
    if (this.listeners.has(listener)) return () => this.listeners.delete(listener);
    if (this.listeners.size >= this.maxListeners) throw new Error(`WorkspaceLandmarkRuntime listener limit exceeded (${this.maxListeners}).`);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.refresh();
    const doc = this.doc;
    if (!doc || typeof MutationObserver === 'undefined') return;
    this.safe(() => {
      this.observer = new MutationObserver(() => this.scheduleRefresh());
      const root = doc.documentElement ?? doc.body;
      if (!root) return;
      this.observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'aria-disabled', 'aria-label', 'aria-labelledby', 'class', 'style', 'tabindex', 'disabled', 'inert'],
      });
      this.win?.addEventListener('resize', this.onResize, { passive: true });
    });
  }

  refresh(): WorkspaceLandmarkInventorySnapshot {
    if (this.disposed) return this.snapshot;
    const doc = this.doc;
    const observations = doc
      ? this.definitions.map((definition) => observeDefinition(definition, doc, this.win))
      : [];
    const next = createWorkspaceLandmarkInventory(observations, {}, this.revision + 1);
    this.revision = next.revision;
    if (!workspaceLandmarkInventoryChanged(this.snapshot, next)) return this.snapshot;
    this.snapshot = next;
    this.publish();
    return this.snapshot;
  }

  scheduleRefresh(): void {
    if (this.disposed || !this.started || this.frame >= 0 || this.fallbackTimer !== null) return;
    if (typeof this.win?.requestAnimationFrame === 'function') {
      this.frame = requestFrame(this.win, () => {
        this.frame = -1;
        this.refresh();
      });
      return;
    }
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.refresh();
    }, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    cancelFrame(this.win, this.frame);
    this.frame = -1;
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    this.win?.removeEventListener('resize', this.onResize);
    this.listeners.clear();
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  isStarted(): boolean {
    return this.started;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private readonly onResize = (): void => this.scheduleRefresh();

  private publish(): void {
    for (const listener of this.listeners) this.safe(listener);
  }

  private safe(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      if (!this.onError) return;
      try {
        this.onError(error);
      } catch (reporterError) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('Workspace landmark diagnostic reporter failed.', reporterError);
        }
      }
    }
  }
}

export const observeWorkspaceLandmark = (
  definition: WorkspaceLandmarkDefinition,
  doc: Document,
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): WorkspaceLandmarkObservation => observeDefinition(definition, doc, win);
