import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { chordMatches, createShortcutChord, evaluateShortcutPolicy } from './mapWorkspaceShortcutPolicy';
import { MAP_WORKSPACE_SHORTCUTS } from './mapWorkspaceShortcuts';
import { createMapWorkspaceDialogSession } from './mapWorkspaceDialogRuntime';
import {
  MAP_SHORTCUT_HELP_CATEGORIES,
  MapShortcutHelpModel,
  type MapShortcutHelpMove,
} from './mapShortcutHelpModel';
import './MapWorkspaceShortcutHelp.css';
import './MapWorkspaceShortcutHelpDiscovery.css';
import './MapWorkspaceShortcutHelpLauncher.css';

export interface MapWorkspaceShortcutHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const HELP_SHORTCUT = Object.freeze({ key: '?', shift: true });
const ACTIVE_DESCENDANT_KEYS: Readonly<Partial<Record<string, MapShortcutHelpMove>>> = Object.freeze({
  ArrowDown: 'next',
  ArrowUp: 'previous',
  Home: 'first',
  End: 'last',
  PageDown: 'page-next',
  PageUp: 'page-previous',
});

export const MapWorkspaceShortcutHelp = ({ open, onClose }: MapWorkspaceShortcutHelpProps) => {
  const titleId = useId();
  const descriptionId = useId();
  const listboxId = useId();
  const statusId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef<MapShortcutHelpModel | null>(null);
  if (!modelRef.current) modelRef.current = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
  const model = modelRef.current;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const activeEntry = snapshot.entries.find((entry) => entry.sourceId === snapshot.activeId) ?? null;

  useEffect(() => () => model.dispose(), [model]);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    model.reset();
    const session = createMapWorkspaceDialogSession(dialogRef.current, onClose);
    session.focusInitial();
    searchRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => { session.handleKeyDown(event); };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      session.dispose();
    };
  }, [model, onClose, open]);

  if (!open) return null;

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const movement = ACTIVE_DESCENDANT_KEYS[event.key];
    if (!movement || snapshot.entries.length === 0) return;
    event.preventDefault();
    model.moveActive(movement);
  };

  return (
    <div className="map-shortcut-help-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="map-shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${statusId}`}
        tabIndex={-1}
      >
        <header className="map-shortcut-help__header">
          <div>
            <p className="map-shortcut-help__eyebrow">Klavye erişimi</p>
            <h2 id={titleId}>Harita kısayolları</h2>
            <p id={descriptionId}>Sık kullanılan harita araçlarını arayın, kategoriye göre süzün ve fare kullanmadan keşfedin.</p>
          </div>
          <button type="button" className="map-shortcut-help__close" onClick={onClose} aria-label="Kısayol yardımını kapat"><span aria-hidden="true">×</span></button>
        </header>

        <div className="map-shortcut-help__body">
          <div className="map-shortcut-help__discovery">
            <label className="map-shortcut-help__search-label" htmlFor={`${listboxId}-search`}>Kısayol ara</label>
            <div className="map-shortcut-help__search-shell">
              <span className="map-shortcut-help__search-glyph" aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                id={`${listboxId}-search`}
                className="map-shortcut-help__search"
                type="search"
                value={snapshot.query}
                placeholder="Örn. ölçüm, Ctrl+K, navigasyon"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded={snapshot.resultCount > 0}
                aria-activedescendant={activeEntry?.id}
                aria-describedby={statusId}
                onChange={(event) => model.setQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {snapshot.query && (
                <button type="button" className="map-shortcut-help__clear" onClick={() => model.setQuery('')} aria-label="Kısayol aramasını temizle">Temizle</button>
              )}
            </div>

            <div className="map-shortcut-help__filters" role="group" aria-label="Kısayol kategorileri">
              {MAP_SHORTCUT_HELP_CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="map-shortcut-help__filter"
                  aria-pressed={snapshot.category === category.id}
                  onClick={() => model.setCategory(category.id)}
                >
                  {category.label}
                </button>
              ))}
            </div>
          </div>

          <p id={statusId} className="map-shortcut-help__result-status" role="status" aria-live="polite" aria-atomic="true">
            {snapshot.announcement}
          </p>

          {snapshot.resultCount > 0 ? (
            <ul id={listboxId} className="map-shortcut-help__list" role="listbox" aria-label="Filtrelenmiş harita kısayolları">
              {snapshot.entries.map((entry) => (
                <li
                  id={entry.id}
                  key={entry.sourceId}
                  className="map-shortcut-help__item"
                  role="option"
                  aria-selected={entry.selected}
                  aria-posinset={entry.position}
                  aria-setsize={entry.setSize}
                  data-active={entry.selected || undefined}
                  onMouseMove={() => model.setActive(entry.sourceId)}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <span className="map-shortcut-help__item-copy">
                    <span className="map-shortcut-help__description">{entry.description}</span>
                    <span className="map-shortcut-help__category">{entry.categoryLabel}</span>
                  </span>
                  <kbd className="map-shortcut-help__key">{entry.label}</kbd>
                </li>
              ))}
            </ul>
          ) : (
            <div className="map-shortcut-help__empty" role="note">
              <strong>Eşleşme bulunamadı</strong>
              <span>{snapshot.emptyReason === 'query' ? 'Arama ifadesini kısaltın veya farklı bir terim deneyin.' : 'Başka bir kısayol kategorisi seçin.'}</span>
              <button type="button" onClick={() => model.reset()}>Tüm kısayolları göster</button>
            </div>
          )}

          <p className="map-shortcut-help__note">Form alanında yazarken, bir modal etkileşimi sürerken veya IME ile metin oluştururken global kısayollar devre dışı kalır. Arama alanında ↑ ↓ Home End PageUp PageDown tuşlarıyla sonuçları keşfedebilirsiniz.</p>
        </div>

        <footer className="map-shortcut-help__footer">
          <span><kbd>Esc</kbd> ile kapatabilirsiniz.</span>
          <span className="map-shortcut-help__footer-count" aria-hidden="true">{snapshot.resultCount}/{snapshot.totalCount}</span>
          <button type="button" className="map-shortcut-help__done" onClick={onClose}>Tamam</button>
        </footer>
      </div>
    </div>
  );
};

export const MapWorkspaceShortcutHelpLauncher = () => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onHelpShortcut = (event: KeyboardEvent): void => {
      if (!evaluateShortcutPolicy(event).allowed) return;
      if (!chordMatches(createShortcutChord(event), HELP_SHORTCUT)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onHelpShortcut);
    return () => window.removeEventListener('keydown', onHelpShortcut);
  }, []);

  return (
    <>
      <button type="button" className="map-shortcut-help__launcher" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span aria-hidden="true">?</span>
        <span className="map-shortcut-help__launcher-label">Kısayollar</span>
      </button>
      <MapWorkspaceShortcutHelp open={open} onClose={() => setOpen(false)} />
    </>
  );
};
