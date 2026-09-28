export const NAVIGATION_SEARCH_QUERY_LIMIT = 160;

export interface NavigationSearchSnapshot {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly canSubmit: boolean;
  readonly isComposing: boolean;
  readonly revision: number;
}

export interface NavigationSearchObserverDiagnostics {
  readonly failureCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
}

export type NavigationSearchListener = () => void;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
}

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

export class NavigationSearchModel {
  private query = '';
  private isComposing = false;
  private revision = 0;
  private readonly listeners = new Set<NavigationSearchListener>();
  private snapshot: NavigationSearchSnapshot = this.buildSnapshot();
  private observerDiagnostics: NavigationSearchObserverDiagnostics = Object.freeze({
    failureCount: 0,
    lastFailureRevision: null,
    lastFailureKind: null,
  });

  getSnapshot = (): NavigationSearchSnapshot => this.snapshot;

  getObserverDiagnostics = (): NavigationSearchObserverDiagnostics => this.observerDiagnostics;

  subscribe = (listener: NavigationSearchListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setQuery(value: string): void {
    const nextQuery = sanitizeNavigationSearchQuery(value);
    if (nextQuery === this.query) return;
    this.query = nextQuery;
    this.publish();
  }

  clear(): void {
    if (this.query.length === 0 && !this.isComposing) return;
    this.query = '';
    this.isComposing = false;
    this.publish();
  }

  beginComposition(): void {
    if (this.isComposing) return;
    this.isComposing = true;
    this.publish();
  }

  endComposition(value?: string): void {
    const nextQuery = value === undefined ? this.query : sanitizeNavigationSearchQuery(value);
    if (!this.isComposing && nextQuery === this.query) return;
    this.query = nextQuery;
    this.isComposing = false;
    this.publish();
  }

  getSubmissionQuery(): string | null {
    if (this.isComposing) return null;
    const normalizedQuery = normalizeNavigationSearchQuery(this.query);
    return normalizedQuery.length > 0 ? normalizedQuery : null;
  }

  private buildSnapshot(): NavigationSearchSnapshot {
    const normalizedQuery = normalizeNavigationSearchQuery(this.query);
    return Object.freeze({
      query: this.query,
      normalizedQuery,
      canSubmit: !this.isComposing && normalizedQuery.length > 0,
      isComposing: this.isComposing,
      revision: this.revision,
    });
  }

  private recordObserverFailure(error: unknown): void {
    this.observerDiagnostics = Object.freeze({
      failureCount: this.observerDiagnostics.failureCount + 1,
      lastFailureRevision: this.revision,
      lastFailureKind: classifyObserverFailure(error),
    });
  }

  private publish(): void {
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
