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

/**
 * DOM contains() stops at a ShadowRoot boundary. Follow composed ancestors
 * when deciding whether focus is still owned by a managed window. Closed
 * roots remain opaque: their host is the only observable focus owner.
 */
export const isWithinComposedSubtree = (
  root: Node | null | undefined,
  target: Node | null | undefined,
): boolean => {
  if (!root || !target) return false;
  let current: Node | null = target;
  while (current) {
    if (current === root) return true;
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    const nodeRoot: Node = current.getRootNode();
    const host: unknown = 'host' in nodeRoot ? nodeRoot.host : null;
    current = host instanceof Node ? host : null;
  }
  return false;
};
