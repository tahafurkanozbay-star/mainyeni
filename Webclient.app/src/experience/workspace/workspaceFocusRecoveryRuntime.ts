import {
  cycleWorkspaceLandmark,
  resolveWorkspaceFocusRecovery,
  workspaceFocusTargetForZone,
  type WorkspaceFocusReason,
  type WorkspaceFocusRecoveryDecision,
  type WorkspaceFocusRecoveryRequest,
  type WorkspaceFocusTarget,
} from './workspaceFocusRecoveryModel';
import type { WorkspaceFocusZone, WorkspaceInputModality } from './workspaceAccessibilityModel';
import type { WorkspaceLandmarkInventorySnapshot } from './workspaceLandmarkInventoryModel';

export type WorkspaceFocusExecutionReason =
  | 'focused'
  | 'target-missing'
  | 'target-hidden'
  | 'target-disabled'
  | 'runtime-disposed'
  | 'focus-failed';

export interface WorkspaceFocusExecutionResult {
  readonly ok: boolean;
  readonly zone: WorkspaceFocusZone | null;
  readonly selector: string | null;
  readonly reason: WorkspaceFocusExecutionReason;
  readonly usedFallback: boolean;
  readonly temporaryTabIndex: boolean;
}

export interface WorkspaceFocusRecoveryRuntimeOptions {
  readonly document?: Document;
  readonly onError?: (error: unknown) => void;
  readonly focusRingAttribute?: string;
}

const DEFAULT_RING_ATTRIBUTE = 'data-workspace-focus-visible';

const frozenResult = (
  ok: boolean,
  zone: WorkspaceFocusZone | null,
  selector: string | null,
  reason: WorkspaceFocusExecutionReason,
  usedFallback = false,
  temporaryTabIndex = false,
): WorkspaceFocusExecutionResult => Object.freeze({ ok, zone, selector, reason, usedFallback, temporaryTabIndex });

const elementIsHidden = (element: HTMLElement): boolean => {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true' || element.closest('[hidden],[aria-hidden="true"],[inert]')) return true;
  return false;
};

const elementIsDisabled = (element: HTMLElement): boolean => {
  if (element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('inert')) return true;
  if ('disabled' in element && typeof element.disabled === 'boolean') return element.disabled;
  return false;
};

const naturallyFocusable = (element: HTMLElement): boolean => {
  if (element.tabIndex >= 0) return true;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toLocaleLowerCase('en-US');
  if (tag === 'a') return element.hasAttribute('href');
  return tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary';
};

const findFocusableDescendant = (root: HTMLElement): HTMLElement | null => {
  const selector = [
    '[autofocus]',
    '[data-workspace-focus-target]',
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const candidate = root.querySelector(selector);
  return candidate instanceof HTMLElement && !elementIsHidden(candidate) && !elementIsDisabled(candidate) ? candidate : null;
};

const resolveSelectorTarget = (doc: Document, selector: string): HTMLElement | null => {
  try {
    const elements = doc.querySelectorAll(selector);
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      if (elementIsHidden(element) || elementIsDisabled(element)) continue;
      return element;
    }
  } catch {
    return null;
  }
  return null;
};

export class WorkspaceFocusRecoveryRuntime {
  private readonly doc: Document | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly focusRingAttribute: string;
  private cleanupTarget: HTMLElement | null = null;
  private cleanupTabIndex: string | null = null;
  private focusRingTarget: HTMLElement | null = null;
  private disposed = false;
  private reporterFailures = 0;

  constructor(options: WorkspaceFocusRecoveryRuntimeOptions = {}) {
    this.doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
    this.onError = options.onError;
    this.focusRingAttribute = options.focusRingAttribute?.trim() || DEFAULT_RING_ATTRIBUTE;
  }

  execute(decision: WorkspaceFocusRecoveryDecision): WorkspaceFocusExecutionResult {
    if (this.disposed) return frozenResult(false, decision.target?.zone ?? null, decision.target?.selector ?? null, 'runtime-disposed');
    if (!decision.shouldRestore || !decision.target) return frozenResult(false, null, null, 'target-missing');
    return this.focusTarget(decision.target, decision.shouldShowFocusRing);
  }

  recover(request: WorkspaceFocusRecoveryRequest): WorkspaceFocusExecutionResult {
    return this.execute(resolveWorkspaceFocusRecovery(request));
  }

  focusZone(zone: WorkspaceFocusZone, modality: WorkspaceInputModality = 'keyboard'): WorkspaceFocusExecutionResult {
    const target = workspaceFocusTargetForZone(zone);
    if (!target) return frozenResult(false, zone, null, 'target-missing');
    if (this.disposed) return frozenResult(false, zone, target.selector, 'runtime-disposed');
    return this.focusTarget(target, modality === 'keyboard');
  }

  cycle(
    current: WorkspaceFocusZone,
    inventory: WorkspaceLandmarkInventorySnapshot,
    modality: WorkspaceInputModality,
    reverse = false,
  ): WorkspaceFocusExecutionResult {
    const zone = cycleWorkspaceLandmark(current, inventory.availableFocusZones, reverse);
    if (!zone) return frozenResult(false, null, null, 'target-missing');
    return this.focusZone(zone, modality);
  }

  recoverDisconnectedFocus(input: {
    readonly preferredZone: WorkspaceFocusZone;
    readonly originZone: WorkspaceFocusZone;
    readonly modality: WorkspaceInputModality;
    readonly inventory: WorkspaceLandmarkInventorySnapshot;
    readonly dialogDepth: number;
    readonly paletteOpen: boolean;
    readonly reason?: WorkspaceFocusReason;
  }): WorkspaceFocusExecutionResult {
    const doc = this.doc;
    if (!doc) return frozenResult(false, null, null, 'target-missing');
    const active = doc.activeElement;
    const connected = active instanceof Element && active.isConnected && active !== doc.body;
    if (connected) return frozenResult(false, null, null, 'target-missing');
    return this.recover({
      reason: input.reason ?? 'surface-removed',
      preferredZone: input.preferredZone,
      originZone: input.originZone,
      modality: input.modality,
      availableZones: input.inventory.availableFocusZones,
      dialogDepth: input.dialogDepth,
      paletteOpen: input.paletteOpen,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupFocusRing();
    this.cleanupTemporaryTabIndex();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getReporterFailureCount(): number {
    return this.reporterFailures;
  }

  private focusTarget(target: WorkspaceFocusTarget, showFocusRing: boolean): WorkspaceFocusExecutionResult {
    const doc = this.doc;
    if (!doc) return frozenResult(false, target.zone, target.selector, 'target-missing');

    let root = resolveSelectorTarget(doc, target.selector);
    let usedFallback = false;
    let selector = target.selector;
    if (!root && target.fallbackSelector) {
      root = resolveSelectorTarget(doc, target.fallbackSelector);
      usedFallback = root !== null;
      selector = target.fallbackSelector;
    }
    if (!root) return frozenResult(false, target.zone, selector, 'target-missing', usedFallback);
    if (elementIsHidden(root)) return frozenResult(false, target.zone, selector, 'target-hidden', usedFallback);
    if (elementIsDisabled(root)) return frozenResult(false, target.zone, selector, 'target-disabled', usedFallback);

    const descendant = naturallyFocusable(root) ? null : findFocusableDescendant(root);
    const focusTarget = descendant ?? root;
    let temporaryTabIndex = false;
    this.cleanupFocusRing();
    this.cleanupTemporaryTabIndex();

    if (!naturallyFocusable(focusTarget)) {
      this.cleanupTarget = focusTarget;
      this.cleanupTabIndex = focusTarget.getAttribute('tabindex');
      focusTarget.setAttribute('tabindex', '-1');
      focusTarget.addEventListener('blur', this.onTemporaryTargetBlur, { once: true });
      temporaryTabIndex = true;
    }

    if (showFocusRing) {
      this.focusRingTarget = focusTarget;
      focusTarget.setAttribute(this.focusRingAttribute, 'true');
      focusTarget.addEventListener('blur', this.onFocusRingBlur, { once: true });
    } else {
      focusTarget.removeAttribute(this.focusRingAttribute);
    }

    try {
      focusTarget.focus({ preventScroll: target.preventScroll });
      if (doc.activeElement !== focusTarget && descendant === null) {
        const fallbackDescendant = findFocusableDescendant(root);
        if (fallbackDescendant) fallbackDescendant.focus({ preventScroll: target.preventScroll });
      }
      const focused = doc.activeElement === focusTarget || (root.contains(doc.activeElement) && doc.activeElement !== null);
      if (!focused) {
        this.cleanupFocusRing();
        this.cleanupTemporaryTabIndex();
      }
      return focused
        ? frozenResult(true, target.zone, selector, 'focused', usedFallback, temporaryTabIndex)
        : frozenResult(false, target.zone, selector, 'focus-failed', usedFallback, temporaryTabIndex);
    } catch (error) {
      this.cleanupFocusRing();
      this.cleanupTemporaryTabIndex();
      this.reportError(error);
      return frozenResult(false, target.zone, selector, 'focus-failed', usedFallback, temporaryTabIndex);
    }
  }

  private readonly onTemporaryTargetBlur = (): void => this.cleanupTemporaryTabIndex();
  private readonly onFocusRingBlur = (): void => this.cleanupFocusRing();

  private cleanupFocusRing(): void {
    const target = this.focusRingTarget;
    if (!target) return;
    target.removeEventListener('blur', this.onFocusRingBlur);
    target.removeAttribute(this.focusRingAttribute);
    this.focusRingTarget = null;
  }

  private cleanupTemporaryTabIndex(): void {
    const target = this.cleanupTarget;
    if (!target) return;
    target.removeEventListener('blur', this.onTemporaryTargetBlur);
    if (this.cleanupTabIndex === null) target.removeAttribute('tabindex');
    else target.setAttribute('tabindex', this.cleanupTabIndex);
    this.cleanupTarget = null;
    this.cleanupTabIndex = null;
  }

  private reportError(error: unknown): void {
    if (!this.onError) return;
    try {
      this.onError(error);
    } catch {
      this.reporterFailures += 1;
    }
  }
}
