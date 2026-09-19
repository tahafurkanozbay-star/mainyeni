export interface OverlayLeaseOptions {
  readonly document: Document;
  readonly id: string;
  readonly modal?: boolean;
  readonly lockScroll?: boolean;
  readonly root?: HTMLElement | null;
}

export interface OverlayLifecycleSnapshot {
  readonly overlayCount: number;
  readonly modalCount: number;
  readonly scrollLockCount: number;
  readonly activeIds: readonly string[];
}

export interface OverlayLease {
  readonly id: string;
  readonly release: () => void;
  readonly getSnapshot: () => OverlayLifecycleSnapshot;
}

interface DocumentOverlayState {
  readonly leases: Map<symbol, Readonly<Required<Pick<OverlayLeaseOptions, 'id' | 'modal' | 'lockScroll'>> & {
    readonly root: HTMLElement | null;
  }>>;
  previousBodyOverflow: string;
  previousBodyOverscrollBehavior: string;
  previousHtmlOverscrollBehavior: string;
  scrollLocked: boolean;
}

const documentStates = new WeakMap<Document, DocumentOverlayState>();

const normalizeOverlayId = (id: unknown): string => {
  const normalized = String(id ?? '').trim();
  if (!normalized) throw new Error('Overlay id is required.');
  if (normalized.length > 96) throw new Error('Overlay id must be 96 characters or fewer.');
  return normalized;
};

const getState = (document: Document): DocumentOverlayState => {
  const existing = documentStates.get(document);
  if (existing) return existing;

  const created: DocumentOverlayState = {
    leases: new Map(),
    previousBodyOverflow: '',
    previousBodyOverscrollBehavior: '',
    previousHtmlOverscrollBehavior: '',
    scrollLocked: false,
  };
  documentStates.set(document, created);
  return created;
};

const counts = (state: DocumentOverlayState): {
  overlayCount: number;
  modalCount: number;
  scrollLockCount: number;
} => {
  let modalCount = 0;
  let scrollLockCount = 0;

  for (const lease of state.leases.values()) {
    if (lease.modal) modalCount += 1;
    if (lease.lockScroll) scrollLockCount += 1;
  }

  return {
    overlayCount: state.leases.size,
    modalCount,
    scrollLockCount,
  };
};

const applyDocumentState = (
  document: Document,
  state: DocumentOverlayState,
): void => {
  const snapshot = counts(state);
  const html = document.documentElement;
  const body = document.body;

  if (snapshot.overlayCount > 0) {
    html.dataset.experienceOverlayCount = String(snapshot.overlayCount);
  } else {
    delete html.dataset.experienceOverlayCount;
  }

  if (snapshot.modalCount > 0) {
    html.dataset.experienceModalOpen = 'true';
  } else {
    delete html.dataset.experienceModalOpen;
  }

  if (snapshot.scrollLockCount > 0 && !state.scrollLocked) {
    state.previousBodyOverflow = body.style.overflow;
    state.previousBodyOverscrollBehavior = body.style.overscrollBehavior;
    state.previousHtmlOverscrollBehavior = html.style.overscrollBehavior;

    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'contain';
    html.style.overscrollBehavior = 'contain';
    state.scrollLocked = true;
  } else if (snapshot.scrollLockCount === 0 && state.scrollLocked) {
    body.style.overflow = state.previousBodyOverflow;
    body.style.overscrollBehavior = state.previousBodyOverscrollBehavior;
    html.style.overscrollBehavior = state.previousHtmlOverscrollBehavior;

    state.previousBodyOverflow = '';
    state.previousBodyOverscrollBehavior = '';
    state.previousHtmlOverscrollBehavior = '';
    state.scrollLocked = false;
  }
};

const snapshotState = (
  state: DocumentOverlayState,
): OverlayLifecycleSnapshot => {
  const currentCounts = counts(state);
  return Object.freeze({
    ...currentCounts,
    activeIds: Object.freeze(
      [...state.leases.values()].map(lease => lease.id),
    ),
  });
};

export const getOverlayLifecycleSnapshot = (
  document: Document,
): OverlayLifecycleSnapshot => snapshotState(getState(document));

export const acquireOverlayLease = (
  options: OverlayLeaseOptions,
): OverlayLease => {
  const { document } = options;
  const state = getState(document);
  const id = normalizeOverlayId(options.id);
  const token = Symbol(id);

  const leaseRecord = Object.freeze({
    id,
    modal: options.modal ?? true,
    lockScroll: options.lockScroll ?? true,
    root: options.root ?? null,
  });

  state.leases.set(token, leaseRecord);
  if (leaseRecord.root) {
    leaseRecord.root.dataset.experienceOverlayActive = 'true';
  }
  applyDocumentState(document, state);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;

    const current = state.leases.get(token);
    state.leases.delete(token);

    if (current?.root && current.root.isConnected) {
      const rootStillLeased = [...state.leases.values()]
        .some(candidate => candidate.root === current.root);
      if (!rootStillLeased) {
        delete current.root.dataset.experienceOverlayActive;
      }
    }

    applyDocumentState(document, state);
  };

  return Object.freeze({
    id,
    release,
    getSnapshot: () => snapshotState(state),
  });
};
