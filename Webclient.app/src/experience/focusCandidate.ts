/**
 * Shared focus eligibility and ownership for modeless windows, result paging
 * and keyboard-roving menus. Do not guess inside closed ShadowRoots.
 */
export const getDeepActiveElement = (documentRef: Document): Element | null => {
  let active = documentRef.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

const hasUnavailableAncestor = (element: HTMLElement): boolean => {
  const view = element.ownerDocument.defaultView;
  let current: HTMLElement | null = element;
  while (current) {
    if (current.hidden || current.hasAttribute('hidden') || current.hasAttribute('inert')) return true;
    if (current.getAttribute('aria-hidden') === 'true' || current.getAttribute('aria-disabled') === 'true') return true;
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return true;
    if (current.parentElement) {
      current = current.parentElement;
    } else {
      const root: Node = current.getRootNode();
      const host: unknown = 'host' in root ? root.host : null;
      current = host instanceof HTMLElement ? host : null;
    }
  }
  return false;
};

export const isManagedFocusCandidate = (
  element: HTMLElement | null | undefined,
): element is HTMLElement => {
  if (!element?.isConnected || hasUnavailableAncestor(element)) return false;
  if (element.hasAttribute('disabled') || element.matches(':disabled')) return false;
  return element.getAttribute('aria-disabled') !== 'true';
};
