import { getDeepActiveElement, isManagedFocusCandidate } from '../../../experience/focusCandidate';

/**
 * Transfers focus only for an actual keyboard-owned paging action.
 * Pointer clicks, stale renders, cancelled requests and deliberate focus changes
 * must never redirect the user's focus to a result card.
 */
export interface OwnedResultFocusOptions {
  readonly trigger: HTMLElement;
  readonly detail: number;
  readonly resolveTarget: () => HTMLElement | null;
  readonly isCurrent: () => boolean;
}

export const scheduleOwnedResultFocus = ({
  trigger,
  detail,
  resolveTarget,
  isCurrent,
}: OwnedResultFocusOptions): (() => void) => {
  const documentRef = trigger.ownerDocument;
  const view = documentRef.defaultView;
  if (!view || detail !== 0 || getDeepActiveElement(documentRef) !== trigger) {
    return () => undefined;
  }

  let cancelled = false;
  let frame = 0;
  const removeListeners = (): void => {
    documentRef.removeEventListener('pointerdown', cancel, true);
    documentRef.removeEventListener('keydown', cancel, true);
    documentRef.removeEventListener('focusin', cancel, true);
    documentRef.removeEventListener('visibilitychange', cancel);
    view.removeEventListener('blur', cancel);
    view.removeEventListener('pagehide', cancel);
  };
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    removeListeners();
    view.cancelAnimationFrame(frame);
  };
  // Renewed keyboard/pointer intent or window deactivation invalidates the
  // handoff, even when removal of the trigger has left only body focused.
  documentRef.addEventListener('pointerdown', cancel, true);
  documentRef.addEventListener('keydown', cancel, true);
  documentRef.addEventListener('focusin', cancel, true);
  documentRef.addEventListener('visibilitychange', cancel);
  view.addEventListener('blur', cancel);
  view.addEventListener('pagehide', cancel);
  frame = view.requestAnimationFrame(() => {
    removeListeners();
    if (cancelled || documentRef.visibilityState === 'hidden' || !isCurrent()) return;
    const currentFocus = getDeepActiveElement(documentRef);
    const stillOwned = currentFocus === trigger
      || (!trigger.isConnected && currentFocus === documentRef.body);
    if (!stillOwned) return;

    const target = resolveTarget();
    if (!isManagedFocusCandidate(target)) return;
    // Keyboard paging must bring the newly focused result into the scroll viewport.
    target.focus();
  });

  return cancel;
};
