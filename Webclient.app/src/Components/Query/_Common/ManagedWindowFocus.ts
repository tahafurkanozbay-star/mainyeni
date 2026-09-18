export interface ManagedWindowFocusOptions {
  readonly root: HTMLElement | null;
  readonly opener?: HTMLElement | null;
  readonly initialFocusSelector?: string;
}

const DEFAULT_FOCUS_SELECTOR = [
  '[autofocus]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const isConnectedFocusable = (element: HTMLElement | null | undefined): element is HTMLElement =>
  Boolean(element?.isConnected && !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');

export function focusManagedWindow({ root, initialFocusSelector = DEFAULT_FOCUS_SELECTOR }: ManagedWindowFocusOptions): HTMLElement | null {
  if (!root?.isConnected) return null;
  const target = root.querySelector<HTMLElement>(initialFocusSelector);
  if (isConnectedFocusable(target)) {
    target.focus({ preventScroll: true });
    return target;
  }
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus({ preventScroll: true });
  return root;
}

export function restoreManagedWindowFocus(opener: HTMLElement | null | undefined): boolean {
  if (!isConnectedFocusable(opener)) return false;
  opener.focus({ preventScroll: true });
  return true;
}

export function captureManagedWindowOpener(documentRef: Document = document): HTMLElement | null {
  const active = documentRef.activeElement;
  return active instanceof HTMLElement && active !== documentRef.body ? active : null;
}

export function scheduleManagedWindowFocus(options: ManagedWindowFocusOptions): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const frame = window.requestAnimationFrame(() => focusManagedWindow(options));
  return () => window.cancelAnimationFrame(frame);
}
