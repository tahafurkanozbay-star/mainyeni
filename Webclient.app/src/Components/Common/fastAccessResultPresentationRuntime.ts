import {
  createFastAccessResultAnnouncement,
  createFastAccessResultPresentationSnapshot,
  type FastAccessResultAnnouncementReason,
  type FastAccessResultPresentationSnapshot,
} from './fastAccessResultPresentationModel';

const HOST_SELECTOR = '.kr-fast-query';
const FILTER_SELECTOR = '.kr-fast-query__filter input[type="search"]';
const ERROR_SELECTOR = '.kr-fast-query__error span';
const MORE_SELECTOR = '.kr-fast-query__more';
const HEADING_SELECTOR = '.kr-fast-query__header h2';

export interface FastAccessResultPresentationState {
  readonly totalRows: number;
  readonly visibleRows: number;
  readonly activeIndex: number | null;
}

export interface FastAccessResultPresentationBinding {
  update(state: FastAccessResultPresentationState): void;
  refresh(): void;
  snapshot(): FastAccessResultPresentationSnapshot;
  dispose(): void;
}

export interface FastAccessResultPresentationRuntimeOptions {
  readonly onError?: (error: unknown) => void;
}

interface OriginalPresentationAttributes {
  readonly ariaBusy: string | null;
  readonly resultStatus: string | null;
  readonly resultCount: string | null;
  readonly activePosition: string | null;
}

const safeReport = (
  reporter: ((error: unknown) => void) | undefined,
  error: unknown,
): void => {
  if (!reporter) return;
  try {
    reporter(error);
  } catch (reportingError) {
    console.warn('Fast-access result presentation reporter failed.', reportingError);
  }
};

const restoreAttribute = (element: Element, name: string, value: string | null): void => {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
};

const readInputValue = (host: HTMLElement | null): string => {
  const input = host?.querySelector<HTMLInputElement>(FILTER_SELECTOR);
  return input?.value ?? '';
};

const readErrorMessage = (host: HTMLElement | null): string | null => {
  const text = host?.querySelector<HTMLElement>(ERROR_SELECTOR)?.textContent?.trim() ?? '';
  return text || null;
};

const readCollectionLabel = (list: HTMLElement, host: HTMLElement | null): string => {
  const explicit = list.getAttribute('aria-label')?.trim();
  if (explicit) return explicit;
  const heading = host?.querySelector<HTMLElement>(HEADING_SELECTOR)?.textContent?.trim();
  return heading ? `${heading} sonuçları` : 'Kent rehberi sonuçları';
};

const isLoading = (host: HTMLElement | null): boolean => host?.getAttribute('aria-busy') === 'true';
const hasMoreResults = (host: HTMLElement | null): boolean => host?.querySelector(MORE_SELECTOR) !== null;

const chooseAnnouncementReason = (
  previous: FastAccessResultPresentationSnapshot | null,
  next: FastAccessResultPresentationSnapshot,
): FastAccessResultAnnouncementReason => {
  if (!previous) return 'initial';
  if (next.status === 'error' && previous.status !== 'error') return 'error';
  if (previous.filterText !== next.filterText) return 'filter';
  if (previous.visibleRows !== next.visibleRows || previous.hasMore !== next.hasMore) return 'page';
  if (previous.totalRows !== next.totalRows || previous.status !== next.status) return 'refresh';
  if (previous.activePosition !== next.activePosition) return 'focus';
  return 'initial';
};

export const bindFastAccessResultPresentation = (
  list: HTMLElement,
  liveStatus: HTMLElement,
  options: FastAccessResultPresentationRuntimeOptions = {},
): FastAccessResultPresentationBinding => {
  const ownerDocument = list.ownerDocument;
  const host = list.closest<HTMLElement>(HOST_SELECTOR);
  const original: OriginalPresentationAttributes = Object.freeze({
    ariaBusy: list.getAttribute('aria-busy'),
    resultStatus: list.getAttribute('data-experience-result-status'),
    resultCount: list.getAttribute('data-experience-result-count'),
    activePosition: list.getAttribute('data-experience-active-position'),
  });

  let disposed = false;
  let queued = false;
  let state: FastAccessResultPresentationState = Object.freeze({
    totalRows: 0,
    visibleRows: 0,
    activeIndex: null,
  });
  let current = createFastAccessResultPresentationSnapshot({
    totalRows: 0,
    visibleRows: 0,
    activeIndex: null,
    collectionLabel: readCollectionLabel(list, host),
    loading: isLoading(host),
    errorMessage: readErrorMessage(host),
    filterText: readInputValue(host),
    hasMore: hasMoreResults(host),
  });

  const apply = (): void => {
    if (disposed) return;
    const previous = current;
    current = createFastAccessResultPresentationSnapshot({
      ...state,
      collectionLabel: readCollectionLabel(list, host),
      loading: isLoading(host),
      errorMessage: readErrorMessage(host),
      filterText: readInputValue(host),
      hasMore: hasMoreResults(host),
    });

    list.setAttribute('aria-busy', String(current.ariaBusy));
    list.setAttribute('data-experience-result-status', current.status);
    list.setAttribute('data-experience-result-count', String(current.totalRows));
    if (current.activePosition === null) list.removeAttribute('data-experience-active-position');
    else list.setAttribute('data-experience-active-position', String(current.activePosition));

    const reason = chooseAnnouncementReason(previous, current);
    const announcement = createFastAccessResultAnnouncement(current, reason);
    liveStatus.setAttribute('aria-live', announcement.mode === 'off' ? 'off' : announcement.mode);
    liveStatus.setAttribute('aria-atomic', String(announcement.atomic));
    liveStatus.textContent = announcement.message;
  };

  const queueApply = (): void => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) apply();
    });
  };

  const handleInput = (event: Event): void => {
    const target = event.target;
    const InputCtor = ownerDocument.defaultView?.HTMLInputElement;
    if (!(InputCtor && target instanceof InputCtor)) return;
    if (!target.matches(FILTER_SELECTOR)) return;
    queueApply();
  };

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => (
      mutation.type === 'childList'
      || mutation.type === 'characterData'
      || mutation.type === 'attributes'
    ))) {
      queueApply();
    }
  });

  try {
    if (host) {
      host.addEventListener('input', handleInput, true);
      observer.observe(host, {
        attributes: true,
        attributeFilter: ['aria-busy'],
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    apply();
  } catch (error) {
    safeReport(options.onError, error);
  }

  return Object.freeze({
    update(nextState: FastAccessResultPresentationState): void {
      if (disposed) return;
      state = Object.freeze({
        totalRows: nextState.totalRows,
        visibleRows: nextState.visibleRows,
        activeIndex: nextState.activeIndex,
      });
      apply();
    },
    refresh(): void {
      if (!disposed) apply();
    },
    snapshot(): FastAccessResultPresentationSnapshot {
      return current;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      host?.removeEventListener('input', handleInput, true);
      restoreAttribute(list, 'aria-busy', original.ariaBusy);
      restoreAttribute(list, 'data-experience-result-status', original.resultStatus);
      restoreAttribute(list, 'data-experience-result-count', original.resultCount);
      restoreAttribute(list, 'data-experience-active-position', original.activePosition);
    },
  });
};
