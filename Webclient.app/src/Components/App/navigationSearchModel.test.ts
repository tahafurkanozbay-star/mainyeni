import { describe, expect, it, vi } from 'vitest';
import { NAVIGATION_SEARCH_QUERY_LIMIT, NavigationSearchModel, normalizeNavigationSearchQuery, sanitizeNavigationSearchQuery } from './navigationSearchModel';

describe('navigationSearchModel', () => {
  it('normalizes whitespace only for submission while preserving editable input', () => {
    const model = new NavigationSearchModel();
    model.setQuery('  Kızılay   Meydanı  ');
    expect(model.getSnapshot().query).toBe('  Kızılay   Meydanı  ');
    expect(model.getSnapshot().normalizedQuery).toBe('Kızılay Meydanı');
    expect(model.getSubmissionQuery()).toBe('Kızılay Meydanı');
  });

  it('removes control characters and enforces a hard query budget without regex control ranges', () => {
    const source = `A\u0000B${'x'.repeat(NAVIGATION_SEARCH_QUERY_LIMIT + 50)}`;
    const result = sanitizeNavigationSearchQuery(source);
    expect(result).not.toContain('\u0000');
    expect(result.length).toBe(NAVIGATION_SEARCH_QUERY_LIMIT);
  });

  it('does not split a multi-code-unit character at the hard query boundary', () => {
    const prefix = 'a'.repeat(NAVIGATION_SEARCH_QUERY_LIMIT - 1);
    expect(sanitizeNavigationSearchQuery(`${prefix}🗺️`)).toBe(prefix);
  });

  it('does not submit blank normalized queries', () => {
    const model = new NavigationSearchModel();
    model.setQuery('     ');
    expect(model.getSnapshot().canSubmit).toBe(false);
    expect(model.getSubmissionQuery()).toBeNull();
  });

  it('suppresses submission during IME composition', () => {
    const model = new NavigationSearchModel();
    model.setQuery('Ankara');
    model.beginComposition();
    expect(model.getSnapshot().isComposing).toBe(true);
    expect(model.getSnapshot().canSubmit).toBe(false);
    expect(model.getSubmissionQuery()).toBeNull();
    model.endComposition('Ankara Çankaya');
    expect(model.getSnapshot().canSubmit).toBe(true);
    expect(model.getSubmissionQuery()).toBe('Ankara Çankaya');
  });

  it('publishes immutable revisioned snapshots only for actual transitions', () => {
    const model = new NavigationSearchModel();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    const initial = model.getSnapshot();
    model.setQuery('Ankara');
    const changed = model.getSnapshot();
    model.setQuery('Ankara');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changed).not.toBe(initial);
    expect(changed.revision).toBe(initial.revision + 1);
    expect(Object.isFrozen(changed)).toBe(true);
    unsubscribe();
    model.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates observer failures and records bounded sanitized diagnostics', () => {
    const model = new NavigationSearchModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('sensitive observer message'); });
    model.subscribe(healthy);
    expect(() => model.setQuery('Ankara')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toEqual({
      failureCount: 1,
      lastFailureRevision: 1,
      lastFailureKind: 'TypeError',
    });
    expect(JSON.stringify(model.getObserverDiagnostics())).not.toContain('sensitive observer message');
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
  });

  it('continues notifying later observers after multiple independent failures', () => {
    const model = new NavigationSearchModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw 'first'; });
    model.subscribe(() => { throw new RangeError('second'); });
    model.subscribe(healthy);
    model.setQuery('Ankara');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toEqual({
      failureCount: 2,
      lastFailureRevision: 1,
      lastFailureKind: 'RangeError',
    });
  });

  it('clears composition and query atomically', () => {
    const model = new NavigationSearchModel();
    model.setQuery('Ankara');
    model.beginComposition();
    model.clear();
    expect(model.getSnapshot()).toMatchObject({ query: '', normalizedQuery: '', canSubmit: false, isComposing: false });
  });

  it.each([
    ['tabs', 'Ankara\tÇankaya', 'AnkaraÇankaya'],
    ['newlines', 'Ankara\nÇankaya', 'AnkaraÇankaya'],
    ['spaces', ' Ankara   Çankaya ', 'Ankara Çankaya'],
    ['turkish', 'İncek Şehit Savcı Mehmet Selim Kiraz Bulvarı', 'İncek Şehit Savcı Mehmet Selim Kiraz Bulvarı'],
  ])('normalizes %s safely', (_name, source, expected) => {
    expect(normalizeNavigationSearchQuery(source)).toBe(expected);
  });
});
