export const NAVIGATION_SEARCH_QUERY_LIMIT = 160;
export const NAVIGATION_SEARCH_OBSERVER_LIMIT = 64;

export interface NavigationSearchSnapshot {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly canSubmit: boolean;
  readonly isComposing: boolean;
  readonly isEmpty: boolean;
  readonly remainingCharacters: number;
  readonly revision: number;
}

export interface NavigationSearchObserverDiagnostics {
  readonly failureCount: number;
  readonly rejectedObserverCount: number;
  readonly activeObserverCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export type NavigationSearchListener = () => void;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
}

/**
 * Keeps the header search boundary deterministic before data reaches the
 * existing global-search window transport. The limit is measured in UTF-16
 * code units to match the browser input maxLength contract, but iteration is
 * code-point aware so a surrogate pair is never cut in half.
 */
export function sanitizeNavigationSearchQuery(value: string): string {
  let result = '';
  for (const character of value) {
    if (isControlCharacter(character)) continue;
    if (result.length + character.length > NAVIGATION_SEARCH_QUERY_LIMIT) break;
    result += character;
  }
  return result;
}

export function normalizeNavigationSearchQuery(value: string): string {
  return normalizeWhitespace(sanitizeNavigationSearchQuery(value));
}

function classifyObserverFailure(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
}

/**
 * Small external-store authority for the persistent navigation search.
 *
 * React owns rendering only. Query admission, IME lifecycle, submit
 * eligibility and observer isolation stay here so desktop/mobile shells share
 * exactly one behavioral contract and tests do not need to emulate DOM state.
 */
export class NavigationSearchModel {
  private query = '';
  private isComposing = false;
  private revision = 0;
  private disposed = false;
  private readonly listeners = new Set<NavigationSearchListener>();
  private snapshot: NavigationSearchSnapshot = this.buildSnapshot();
  private observerDiagnostics: NavigationSearchObserverDiagnostics = Object.freeze({
    failureCount: 0,
    rejectedObserverCount: 0,
    activeObserverCount: 0,
    lastFailureRevision: null,
    lastFailureKind: null,
    disposed: false,
  });

  getSnapshot = (): NavigationSearchSnapshot => this.snapshot;

  getObserverDiagnostics = (): NavigationSearchObserverDiagnostics => this.observerDiagnostics;

  subscribe = (listener: NavigationSearchListener): (() => void) => {
    if (this.disposed) {
      this.recordRejectedObserver();
      return () => undefined;
    }
    if (this.listeners.has(listener)) {
      return () => this.unsubscribe(listener);
    }
    if (this.listeners.size >= NAVIGATION_SEARCH_OBSERVER_LIMIT) {
      this.recordRejectedObserver();
      return () => undefined;
    }
    this.listeners.add(listener);
    this.refreshObserverCount();
    return () => this.unsubscribe(listener);
  };

  setQuery(value: string): void {
    if (this.disposed) return;
    const nextQuery = sanitizeNavigationSearchQuery(value);
    if (nextQuery === this.query) return;
    this.query = nextQuery;
    this.publish();
  }

  clear(): void {
    if (this.disposed || (this.query.length === 0 && !this.isComposing)) return;
    this.query = '';
    this.isComposing = false;
    this.publish();
  }

  beginComposition(): void {
    if (this.disposed || this.isComposing) return;
    this.isComposing = true;
    this.publish();
  }

  endComposition(value?: string): void {
    if (this.disposed) return;
    const nextQuery = value === undefined ? this.query : sanitizeNavigationSearchQuery(value);
    if (!this.isComposing && nextQuery === this.query) return;
    this.query = nextQuery;
    this.isComposing = false;
    this.publish();
  }

  getSubmissionQuery(): string | null {
    if (this.disposed || this.isComposing) return null;
    const normalizedQuery = normalizeNavigationSearchQuery(this.query);
    return normalizedQuery.length > 0 ? normalizedQuery : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  private recordRejectedObserver(): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      rejectedObserverCount: this.observerDiagnostics.rejectedObserverCount + 1,
    });
  }

  private unsubscribe(listener: NavigationSearchListener): void {
    if (!this.listeners.delete(listener)) return;
    this.refreshObserverCount();
  }

  private refreshObserverCount(): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      activeObserverCount: this.listeners.size,
    });
  }

  private buildSnapshot(): NavigationSearchSnapshot {
    const normalizedQuery = normalizeNavigationSearchQuery(this.query);
    return Object.freeze({
      query: this.query,
      normalizedQuery,
      canSubmit: !this.disposed && !this.isComposing && normalizedQuery.length > 0,
      isComposing: this.isComposing,
      isEmpty: normalizedQuery.length === 0,
      remainingCharacters: Math.max(0, NAVIGATION_SEARCH_QUERY_LIMIT - this.query.length),
      revision: this.revision,
    });
  }

  private recordObserverFailure(error: unknown): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      failureCount: this.observerDiagnostics.failureCount + 1,
      lastFailureRevision: this.revision,
      lastFailureKind: classifyObserverFailure(error),
    });
  }

  private publish(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.recordObserverFailure(error);
      }
    }
  }
}
