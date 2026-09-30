import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  MAP_WORKSPACE_GUIDE_CATEGORIES,
  MapWorkspaceGuideModel,
  type MapWorkspaceGuideCategory,
  type MapWorkspaceGuideMove,
} from './mapWorkspaceGuideModel';
import './MapWorkspaceGuidePanel.css';

export interface MapWorkspaceGuidePanelProps {
  readonly active?: boolean;
  readonly model?: MapWorkspaceGuideModel;
}

const NAVIGATION_KEYS: Readonly<Record<string, MapWorkspaceGuideMove>> = Object.freeze({
  ArrowDown: 'next',
  ArrowUp: 'previous',
  Home: 'first',
  End: 'last',
  PageDown: 'page-next',
  PageUp: 'page-previous',
});

export const MapWorkspaceGuidePanel = ({
  active = true,
  model: suppliedModel,
}: MapWorkspaceGuidePanelProps) => {
  const model = useMemo(() => suppliedModel ?? new MapWorkspaceGuideModel(), [suppliedModel]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (!suppliedModel) model.dispose();
  }, [model, suppliedModel]);

  useEffect(() => {
    if (!active) return;
    const activeOption = snapshot.activeEntry
      ? document.getElementById(snapshot.activeEntry.id)
      : null;
    activeOption?.scrollIntoView?.({ block: 'nearest' });
  }, [active, snapshot.activeEntry]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const move = NAVIGATION_KEYS[event.key];
    if (!move) return;
    event.preventDefault();
    model.moveActive(move);
  };

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const move = NAVIGATION_KEYS[event.key];
    if (move) {
      event.preventDefault();
      model.moveActive(move);
      requestAnimationFrame(() => {
        const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
        selected?.focus({ preventScroll: true });
      });
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      searchRef.current?.focus({ preventScroll: true });
    }
  };

  const setCategory = (category: MapWorkspaceGuideCategory): void => {
    model.setCategory(category);
    searchRef.current?.focus({ preventScroll: true });
  };

  const activeEntry = snapshot.activeEntry;
  const activeDescendant = activeEntry?.id;

  return (
    <section
      className="map-workspace-guide"
      aria-label="Kent Rehberi çalışma alanı rehberi"
      hidden={!active}
      data-empty={String(snapshot.empty)}
    >
      <div className="map-workspace-guide__discovery">
        <label className="map-workspace-guide__search-label" htmlFor="map-workspace-guide-search">
          Çalışma alanı rehberinde ara
        </label>
        <div className="map-workspace-guide__search-shell">
          <span className="map-workspace-guide__search-glyph" aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            id="map-workspace-guide-search"
            type="search"
            className="map-workspace-guide__search"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="map-workspace-guide-list"
            aria-expanded={snapshot.resultCount > 0}
            aria-activedescendant={activeDescendant}
            value={snapshot.query}
            placeholder="Örn. 3D, ölçüm, çevrimdışı, tablo…"
            onChange={(event) => model.setQuery(event.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {snapshot.query ? (
            <button
              type="button"
              className="map-workspace-guide__clear"
              aria-label="Rehber aramasını temizle"
              onClick={() => {
                model.setQuery('');
                searchRef.current?.focus({ preventScroll: true });
              }}
            >
              Temizle
            </button>
          ) : null}
        </div>

        <div className="map-workspace-guide__filters" role="group" aria-label="Rehber kategorileri">
          {MAP_WORKSPACE_GUIDE_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              className="map-workspace-guide__filter"
              aria-pressed={snapshot.category === category.id}
              onClick={() => setCategory(category.id)}
            >
              {category.label}
            </button>
          ))}
        </div>

        <div className="map-workspace-guide__status-row">
          <span role="status" aria-live="polite" aria-atomic="true">
            {snapshot.announcement}
          </span>
          <span className="map-workspace-guide__count" aria-hidden="true">
            {snapshot.resultCount}/{snapshot.totalCount}
          </span>
        </div>
      </div>

      {snapshot.empty ? (
        <div className="map-workspace-guide__empty">
          <strong>Rehber konusu bulunamadı</strong>
          <span>Arama ifadesini sadeleştirin veya tüm kategorilere dönün.</span>
          <button type="button" onClick={() => model.reset()}>Tüm rehberi göster</button>
        </div>
      ) : (
        <div className="map-workspace-guide__layout">
          <div
            ref={listRef}
            id="map-workspace-guide-list"
            className="map-workspace-guide__list"
            role="listbox"
            aria-label="Çalışma alanı rehber konuları"
            aria-activedescendant={activeDescendant}
          >
            {snapshot.entries.map((entry) => (
              <button
                key={entry.sourceId}
                id={entry.id}
                type="button"
                role="option"
                className="map-workspace-guide__topic"
                aria-selected={entry.selected}
                aria-posinset={entry.position}
                aria-setsize={entry.setSize}
                tabIndex={entry.selected ? 0 : -1}
                onFocus={() => model.setActive(entry.sourceId)}
                onMouseMove={() => model.setActive(entry.sourceId)}
                onClick={() => model.setActive(entry.sourceId)}
                onKeyDown={handleOptionKeyDown}
              >
                <span className="map-workspace-guide__topic-category">{entry.categoryLabel}</span>
                <strong>{entry.title}</strong>
                <span>{entry.summary}</span>
              </button>
            ))}
          </div>

          {activeEntry ? (
            <article className="map-workspace-guide__detail" aria-labelledby={`${activeEntry.id}-detail-title`}>
              <div className="map-workspace-guide__detail-heading">
                <span>{activeEntry.categoryLabel}</span>
                <h3 id={`${activeEntry.id}-detail-title`}>{activeEntry.title}</h3>
                <p>{activeEntry.summary}</p>
              </div>
              <ol className="map-workspace-guide__steps">
                {activeEntry.steps.map((step, index) => (
                  <li key={`${activeEntry.sourceId}-step-${index + 1}`}>
                    <span className="map-workspace-guide__step-index" aria-hidden="true">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              {activeEntry.shortcutHint ? (
                <p className="map-workspace-guide__shortcut-note">
                  <span>Kısayol</span>
                  <kbd>{activeEntry.shortcutHint}</kbd>
                </p>
              ) : null}
            </article>
          ) : null}
        </div>
      )}
    </section>
  );
};

export default MapWorkspaceGuidePanel;