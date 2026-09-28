export const NAVIGATION_SEARCH_QUERY_LIMIT = 160;

export interface NavigationSearchSnapshot {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly canSubmit: boolean;
  readonly isComposing: boolean;
  readonly revision: number;
}

export type NavigationSearchListener = () => void;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function sanitizeNavigationSearchQuery(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, NAVIGATION_SEARCH_QUERY_LIMIT);
}

export function normalizeNavigationSearchQuery(value: string): string {
  return normalizeWhitespace(sanitizeNavigationSearchQuery(value));
}

export class NavigationSearchModel {
  private query = '';
  private isComposing = false;
  private revision = 0;
  private readonly listeners = new Set<NavigationSearchListener>();
  private snapshot: NavigationSearchSnapshot = this.buildSnapshot();

  getSnapshot = (): NavigationSearchSnapshot => this.snapshot;

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

  private publish(): void {
    this.revision += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // One observer must not break input interaction for the rest of the shell.
      }
    }
  }
}
