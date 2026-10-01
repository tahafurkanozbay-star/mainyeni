import { useEffect } from 'react';
import {
  createDataTableAccessibilityController,
  type DataTableAccessibilityController,
  type DataTableKeyboardEventLike,
} from '../../experience/dataTableAccessibilityController';
import {
  createDataTableInteractionModel,
  type DataTableInteractionModel,
  type DataTableSnapshot,
} from '../../experience/dataTableInteractionModel';
import { bindFastAccessResultPresentation } from './fastAccessResultPresentationRuntime';
import './FastAccessResultAccessibilityBridge.css';

const RESULT_LIST_SELECTOR = '.kr-fast-query__results';
const RESULT_ROW_CLASS = 'kr-fast-query__item';
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
].join(',');
const MAX_BRIDGED_ROWS = 10_000;
const MODEL_PAGE_SIZE = 250;

let surfaceSequence = 0;

interface BridgeRow {
  readonly key: string;
  readonly element: HTMLElement;
  readonly label: string;
}

interface OriginalRowAttributes {
  readonly id: string | null;
  readonly tabIndex: string | null;
  readonly ariaPosInSet: string | null;
  readonly ariaSetSize: string | null;
  readonly ariaKeyShortcuts: string | null;
  readonly rowKey: string | null;
  readonly active: string | null;
}

interface BoundRow {
  readonly element: HTMLElement;
  readonly original: OriginalRowAttributes;
  readonly key: string;
  position: number;
}

export interface FastAccessResultListBinding {
  readonly list: HTMLElement;
  refresh(): void;
  dispose(): void;
}

export interface FastAccessResultAccessibilityOptions {
  readonly onError?: (error: unknown) => void;
}

const normalizeToken = (value: string): string => value
  .trim()
  .replace(/[^a-zA-Z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '');

const appendToken = (value: string | null, token: string): string => {
  const tokens = new Set((value ?? '').split(/\s+/).filter(Boolean));
  tokens.add(token);
  return Array.from(tokens).join(' ');
};

const restoreAttribute = (
  element: Element,
  name: string,
  value: string | null,
): void => {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
};

const safeReport = (
  reporter: ((error: unknown) => void) | undefined,
  error: unknown,
): void => {
  if (!reporter) return;
  try {
    reporter(error);
  } catch (reportingError) {
    console.warn('Fast-access result accessibility reporter failed.', reportingError);
  }
};

const directResultRows = (list: HTMLElement): HTMLElement[] => Array.from(list.children)
  .filter((element): element is HTMLElement => element.classList.contains(RESULT_ROW_CLASS));

const rowLabel = (row: HTMLElement, index: number): string => {
  const title = row.querySelector<HTMLElement>('.result-item-info-title')?.textContent?.trim() ?? '';
  const address = row.querySelector<HTMLElement>('.result-item-info-address')?.textContent?.trim() ?? '';
  const phone = row.querySelector<HTMLAnchorElement>('a[href^="tel:"]')?.textContent?.trim() ?? '';
  const combined = [title, address, phone].filter(Boolean).join(', ');
  return combined || `Sonuç ${index + 1}`;
};

const isInteractiveTarget = (target: HTMLElement, row: HTMLElement): boolean => {
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  return interactive !== null && interactive !== row;
};

const preserveRowAttributes = (row: HTMLElement): OriginalRowAttributes => Object.freeze({
  id: row.getAttribute('id'),
  tabIndex: row.getAttribute('tabindex'),
  ariaPosInSet: row.getAttribute('aria-posinset'),
  ariaSetSize: row.getAttribute('aria-setsize'),
  ariaKeyShortcuts: row.getAttribute('aria-keyshortcuts'),
  rowKey: row.getAttribute('data-experience-row-key'),
  active: row.getAttribute('data-experience-row-active'),
});

const restoreRow = (bound: BoundRow): void => {
  const { element, original } = bound;
  restoreAttribute(element, 'id', original.id);
  restoreAttribute(element, 'tabindex', original.tabIndex);
  restoreAttribute(element, 'aria-posinset', original.ariaPosInSet);
  restoreAttribute(element, 'aria-setsize', original.ariaSetSize);
  restoreAttribute(element, 'aria-keyshortcuts', original.ariaKeyShortcuts);
  restoreAttribute(element, 'data-experience-row-key', original.rowKey);
  restoreAttribute(element, 'data-experience-row-active', original.active);
};

const asKeyboardEventLike = (event: KeyboardEvent): DataTableKeyboardEventLike => ({
  key: event.key,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  preventDefault: () => event.preventDefault(),
});

export const bindFastAccessResultList = (
  list: HTMLElement,
  options: FastAccessResultAccessibilityOptions = {},
): FastAccessResultListBinding => {
  const ownerDocument = list.ownerDocument;
  const HTMLElementCtor = ownerDocument.defaultView?.HTMLElement;
  const originalListId = list.getAttribute('id');
  const originalRole = list.getAttribute('role');
  const originalAriaKeyShortcuts = list.getAttribute('aria-keyshortcuts');
  const originalAriaDescribedBy = list.getAttribute('aria-describedby');
  const originalBridgeMarker = list.getAttribute('data-experience-results-a11y');
  const surfaceId = normalizeToken(
    list.id || `fast-query-results-${++surfaceSequence}`,
  ) || `fast-query-results-${++surfaceSequence}`;

  if (!list.id) list.id = surfaceId;

  const liveStatus = ownerDocument.createElement('p');
  liveStatus.id = `${surfaceId}-keyboard-status`;
  liveStatus.className = 'kr-fast-query__a11y-status';
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.setAttribute('aria-atomic', 'true');
  list.before(liveStatus);

  list.setAttribute('role', originalRole ?? 'list');
  list.setAttribute('data-experience-results-a11y', 'true');
  list.setAttribute(
    'aria-keyshortcuts',
    appendToken(originalAriaKeyShortcuts, 'ArrowDown ArrowUp Control+Home Control+End'),
  );
  list.setAttribute(
    'aria-describedby',
    appendToken(originalAriaDescribedBy, liveStatus.id),
  );

  const presentation = bindFastAccessResultPresentation(list, liveStatus, {
    onError: (error) => safeReport(options.onError, error),
  });

  const model: DataTableInteractionModel<BridgeRow> = createDataTableInteractionModel({
    rowId: (row) => row.key,
    columns: [
      {
        id: 'result',
        label: 'Sonuç',
        value: (row) => row.label,
      },
    ],
    selectionMode: 'none',
    pageSize: MODEL_PAGE_SIZE,
    maxRows: MAX_BRIDGED_ROWS,
    onObserverError: (error) => safeReport(options.onError, error),
  });

  const controller: DataTableAccessibilityController = createDataTableAccessibilityController({
    model,
    tableId: `${surfaceId}-experience`,
    selectionMode: 'none',
    onFocusRequest(rowDomId) {
      const target = ownerDocument.getElementById(rowDomId);
      if (!(HTMLElementCtor && target instanceof HTMLElementCtor)) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    },
    onObserverError: (error) => safeReport(options.onError, error),
  });

  const boundRows = new Map<HTMLElement, BoundRow>();
  let disposed = false;
  let syncQueued = false;
  let rowSequence = 0;

  const ensureBoundRow = (element: HTMLElement, index: number): BoundRow => {
    const existing = boundRows.get(element);
    if (existing) return existing;

    const existingKey = element.getAttribute('data-experience-row-key')?.trim();
    const key = existingKey || `item-${++rowSequence}`;
    const bound: BoundRow = {
      element,
      key,
      position: index + 1,
      original: preserveRowAttributes(element),
    };
    boundRows.set(element, bound);
    return bound;
  };

  const applySnapshot = (snapshot: DataTableSnapshot<BridgeRow>): void => {
    if (disposed) return;

    for (const bound of boundRows.values()) {
      bound.element.id = `${surfaceId}-experience-row-${normalizeToken(bound.key)}`;
      bound.element.tabIndex = -1;
      bound.element.setAttribute('aria-posinset', String(bound.position));
      bound.element.setAttribute('aria-setsize', String(snapshot.totalRows));
      bound.element.setAttribute('data-experience-row-key', bound.key);
      bound.element.setAttribute('data-experience-row-active', 'false');
      bound.element.setAttribute(
        'aria-keyshortcuts',
        appendToken(
          bound.original.ariaKeyShortcuts,
          'ArrowDown ArrowUp Control+Home Control+End',
        ),
      );
    }

    for (const row of snapshot.rows) {
      const bound = boundRows.get(row.value.element);
      if (!bound) continue;
      const facts = controller.row(row.id);
      if (!facts) continue;
      bound.element.id = facts.id;
      bound.element.tabIndex = facts.tabIndex;
      bound.element.setAttribute('data-experience-row-active', String(facts.active));
    }

    let activeIndex: number | null = null;
    if (snapshot.activeRowId !== null) {
      for (const bound of boundRows.values()) {
        if (bound.key === snapshot.activeRowId) {
          activeIndex = Math.max(0, bound.position - 1);
          break;
        }
      }
    }

    presentation.update({
      totalRows: snapshot.totalRows,
      visibleRows: Math.min(snapshot.totalRows, directResultRows(list).length),
      activeIndex,
    });
  };

  const unsubscribeModel = model.subscribe(applySnapshot);

  const sync = (): void => {
    if (disposed) return;
    const allRows = directResultRows(list);
    const liveRows = new Set(allRows);

    for (const [element, bound] of boundRows) {
      if (!liveRows.has(element)) {
        restoreRow(bound);
        boundRows.delete(element);
      }
    }

    const rows = allRows.slice(0, MAX_BRIDGED_ROWS).map((element, index): BridgeRow => {
      const bound = ensureBoundRow(element, index);
      bound.position = index + 1;
      return Object.freeze({
        key: bound.key,
        element,
        label: rowLabel(element, index),
      });
    });

    if (allRows.length > MAX_BRIDGED_ROWS) {
      list.setAttribute('data-experience-results-overflow', 'true');
      safeReport(
        options.onError,
        new Error(`Sonuç listesi ${MAX_BRIDGED_ROWS} kayıt erişilebilirlik sınırını aşıyor.`),
      );
    } else {
      list.removeAttribute('data-experience-results-overflow');
    }

    model.setRows(rows);
    const snapshot = model.snapshot();
    if (rows.length > 0 && snapshot.activeRowId === null) {
      model.setActive(rows[0]?.key ?? null);
    }
    presentation.refresh();
  };

  const queueSync = (): void => {
    if (disposed || syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      if (!disposed) sync();
    });
  };

  const rowFromTarget = (target: EventTarget | null): HTMLElement | null => {
    if (!(HTMLElementCtor && target instanceof HTMLElementCtor)) return null;
    const row = target.closest<HTMLElement>(`.${RESULT_ROW_CLASS}`);
    if (!row || row.parentElement !== list) return null;
    return row;
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    const row = rowFromTarget(event.target);
    if (!row || event.target !== row) return;
    if (
      event.key !== 'ArrowDown'
      && event.key !== 'ArrowUp'
      && !(event.ctrlKey && (event.key === 'Home' || event.key === 'End'))
    ) {
      return;
    }
    controller.activate(row.getAttribute('data-experience-row-key') ?? '');
    controller.handleKey(asKeyboardEventLike(event));
  };

  const handleFocusIn = (event: FocusEvent): void => {
    const row = rowFromTarget(event.target);
    if (!row || event.target !== row) return;
    controller.activate(row.getAttribute('data-experience-row-key') ?? '');
  };

  const handlePointerDown = (event: PointerEvent): void => {
    const row = rowFromTarget(event.target);
    if (!row) return;
    const target = event.target;
    if (!(HTMLElementCtor && target instanceof HTMLElementCtor)) return;
    if (isInteractiveTarget(target, row)) return;
    controller.activate(row.getAttribute('data-experience-row-key') ?? '');
  };

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.type === 'childList')) queueSync();
  });

  list.addEventListener('keydown', handleKeyDown);
  list.addEventListener('focusin', handleFocusIn);
  list.addEventListener('pointerdown', handlePointerDown);
  observer.observe(list, { childList: true });
  sync();

  return Object.freeze({
    list,
    refresh() {
      sync();
      presentation.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      list.removeEventListener('keydown', handleKeyDown);
      list.removeEventListener('focusin', handleFocusIn);
      list.removeEventListener('pointerdown', handlePointerDown);
      unsubscribeModel();
      controller.dispose();
      model.dispose();
      presentation.dispose();

      for (const bound of boundRows.values()) restoreRow(bound);
      boundRows.clear();

      restoreAttribute(list, 'id', originalListId);
      restoreAttribute(list, 'role', originalRole);
      restoreAttribute(list, 'aria-keyshortcuts', originalAriaKeyShortcuts);
      restoreAttribute(list, 'aria-describedby', originalAriaDescribedBy);
      restoreAttribute(list, 'data-experience-results-a11y', originalBridgeMarker);
      list.removeAttribute('data-experience-results-overflow');
      liveStatus.remove();
    },
  });
};

export const installFastAccessResultAccessibilityBridge = (
  root: Document = document,
  options: FastAccessResultAccessibilityOptions = {},
): (() => void) => {
  const bindings = new Map<HTMLElement, FastAccessResultListBinding>();
  let disposed = false;
  let scanQueued = false;

  const scan = (): void => {
    if (disposed) return;
    const discovered = new Set(
      Array.from(root.querySelectorAll<HTMLElement>(RESULT_LIST_SELECTOR)),
    );

    for (const [list, binding] of bindings) {
      if (!discovered.has(list) || !list.isConnected) {
        binding.dispose();
        bindings.delete(list);
      }
    }

    for (const list of discovered) {
      if (bindings.has(list)) continue;
      try {
        bindings.set(list, bindFastAccessResultList(list, options));
      } catch (error) {
        safeReport(options.onError, error);
      }
    }
  };

  const queueScan = (): void => {
    if (disposed || scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      scan();
    });
  };

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.type === 'childList')) queueScan();
  });

  if (root.body) observer.observe(root.body, { childList: true, subtree: true });
  scan();

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    for (const binding of bindings.values()) binding.dispose();
    bindings.clear();
  };
};

export const FastAccessResultAccessibilityBridge = (): null => {
  useEffect(() => installFastAccessResultAccessibilityBridge(document), []);
  return null;
};
