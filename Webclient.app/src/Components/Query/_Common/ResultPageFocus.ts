import { isManagedFocusCandidate } from './ManagedWindowFocus';

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

/** Walk only open shadow roots; closed roots cannot be inspected safely. */
const activeFocusElement = (documentRef: Document): Element | null => {
  let active = documentRef.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

export const scheduleOwnedResultFocus = ({
  trigger,
  detail,
  resolveTarget,
  isCurrent,
}: OwnedResultFocusOptions): (() => void) => {
  const documentRef = trigger.ownerDocument;
  const view = documentRef.defaultView;
  if (!view || detail !== 0 || activeFocusElement(documentRef) !== trigger) {
    return () => undefined;
  }

  let cancelled = false;
  let frame = 0;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    documentRef.removeEventListener('pointerdown', cancel, true);
    documentRef.removeEventListener('visibilitychange', cancel);
    view.cancelAnimationFrame(frame);
  };
  // A map gesture can leave body focused after the paging button disappears.
  documentRef.addEventListener('pointerdown', cancel, true);
  documentRef.addEventListener('visibilitychange', cancel);
  frame = view.requestAnimationFrame(() => {
    documentRef.removeEventListener('pointerdown', cancel, true);
    documentRef.removeEventListener('visibilitychange', cancel);
    if (cancelled || documentRef.visibilityState === 'hidden' || !isCurrent()) return;
    const currentFocus = activeFocusElement(documentRef);
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
