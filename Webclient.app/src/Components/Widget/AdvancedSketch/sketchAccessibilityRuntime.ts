import type { SketchTool } from './sketchContracts';

export interface SketchToolDescriptor {
  readonly tool: SketchTool;
  readonly label: string;
  readonly description: string;
  readonly shortcut: string | null;
  readonly destructive: boolean;
}

export const SKETCH_TOOL_DESCRIPTORS: readonly SketchToolDescriptor[] = Object.freeze([
  Object.freeze({ tool: 'move', label: 'Seç', description: 'Mevcut çizimleri seç ve düzenle.', shortcut: 'V', destructive: false }),
  Object.freeze({ tool: 'point', label: 'Nokta', description: 'Haritaya nokta ekle.', shortcut: 'P', destructive: false }),
  Object.freeze({ tool: 'polyline', label: 'Çizgi', description: 'Birden çok köşeden çizgi oluştur.', shortcut: 'L', destructive: false }),
  Object.freeze({ tool: 'freehand', label: 'Serbest çizim', description: 'İşaretçi hareketiyle serbest çizgi oluştur.', shortcut: 'F', destructive: false }),
  Object.freeze({ tool: 'polygon', label: 'Poligon', description: 'Kapalı alan çiz.', shortcut: 'G', destructive: false }),
  Object.freeze({ tool: 'circle', label: 'Daire', description: 'Merkez ve yarıçap ile daire çiz.', shortcut: 'C', destructive: false }),
  Object.freeze({ tool: 'rectangle', label: 'Dikdörtgen', description: 'Dikdörtgen alan çiz.', shortcut: 'R', destructive: false }),
  Object.freeze({ tool: 'clear', label: 'Temizle', description: 'Tüm çizimleri temizle.', shortcut: null, destructive: true }),
]);

const byTool = new Map(SKETCH_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.tool, descriptor] as const));

export const describeSketchTool = (tool: SketchTool): SketchToolDescriptor =>
  byTool.get(tool) ?? SKETCH_TOOL_DESCRIPTORS[0]!;

export const sketchToolFromShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented'>,
): SketchTool | null => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const key = event.key.trim().toUpperCase();
  if (!key) return null;
  return SKETCH_TOOL_DESCRIPTORS.find((descriptor) => descriptor.shortcut === key)?.tool ?? null;
};

const isEditableTarget = (target: HTMLElement): boolean => {
  if (target.isContentEditable) return true;
  const ownContentEditable = target.getAttribute('contenteditable');
  if (ownContentEditable !== null && ownContentEditable.toLowerCase() !== 'false') return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
};

export const shouldHandleSketchShortcut = (
  event: Pick<KeyboardEvent, 'target' | 'isComposing' | 'defaultPrevented'>,
): boolean => {
  if (event.defaultPrevented || event.isComposing) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (isEditableTarget(target)) return false;
  const tag = target.tagName.toLowerCase();
  return tag !== 'input' && tag !== 'textarea' && tag !== 'select';
};

export const announceSketchStatus = (
  liveRegion: HTMLElement | null,
  message: string,
  assertive = false,
): void => {
  if (!liveRegion) return;
  liveRegion.setAttribute('role', assertive ? 'alert' : 'status');
  liveRegion.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.textContent = message;
};

export const createSketchLiveRegion = (ownerDocument: Document = document): HTMLElement => {
  const existing = ownerDocument.getElementById('advanced-sketch-live-region');
  if (existing instanceof HTMLElement) return existing;
  const element = ownerDocument.createElement('div');
  element.id = 'advanced-sketch-live-region';
  element.className = 'visually-hidden';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-atomic', 'true');
  ownerDocument.body.appendChild(element);
  return element;
};

export const focusSketchToolbarItem = (
  items: readonly HTMLElement[],
  currentIndex: number,
  direction: 'next' | 'previous' | 'first' | 'last',
): number => {
  if (items.length === 0) return -1;
  let next = currentIndex;
  if (direction === 'first') next = 0;
  else if (direction === 'last') next = items.length - 1;
  else if (direction === 'next') next = (Math.max(0, currentIndex) + 1) % items.length;
  else next = (Math.max(0, currentIndex) - 1 + items.length) % items.length;

  items.forEach((item, index) => {
    item.tabIndex = index === next ? 0 : -1;
  });
  items[next]?.focus();
  return next;
};
