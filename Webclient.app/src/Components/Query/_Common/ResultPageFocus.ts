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
  const frame = view.requestAnimationFrame(() => {
    if (cancelled || !isCurrent()) return;
    const currentFocus = activeFocusElement(documentRef);
    const stillOwned = currentFocus === trigger
      || (!trigger.isConnected && currentFocus === documentRef.body);
    if (!stillOwned) return;

    const target = resolveTarget();
    if (!isManagedFocusCandidate(target)) return;
    // Keyboard paging must bring the newly focused result into the scroll viewport.
    target.focus();
  });

  return () => {
    cancelled = true;
    view.cancelAnimationFrame(frame);
  };
};
