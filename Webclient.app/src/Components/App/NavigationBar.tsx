import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppConfig } from '../../Core/AppConfig';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { CompanyLogo } from './CompanyLogo';
import { NAVIGATION_SEARCH_QUERY_LIMIT, NavigationSearchModel } from './navigationSearchModel';
import { resolveNavigationShortcut } from './navigationShortcutPolicy';
import './NavigationBar.css';

export interface NavigationBarProps {
  readonly id?: string;
  readonly windowManager: Pick<WindowManagerApi, 'ShowWindow'>;
}

export function NavigationBar({ windowManager }: NavigationBarProps) {
  const searchModel = useMemo(() => new NavigationSearchModel(), []);
  const search = useSyncExternalStore(searchModel.subscribe, searchModel.getSnapshot, searchModel.getSnapshot);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent): void => {
      const decision = resolveNavigationShortcut(event);
      if (decision.intent !== 'focus-search') return;
      if (decision.preventDefault) event.preventDefault();
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, []);

  const openGlobalSearch = (): void => {
    const name = searchModel.getSubmissionQuery();
    if (name === null) return;
    windowManager.ShowWindow('genelarama-query-window', { name });
  };

  return (
    <header className="mainbar-container" role="banner" aria-label="Kent Rehberi üst gezinme">
      <div className="row h-100"><div className="col-12 h-100"><div className="mainbar">
        <div className="mainbar-logo"><a href="https://www.ankara.bel.tr/" target="_blank" rel="noopener noreferrer" aria-label="Ankara Büyükşehir Belediyesi ana sayfası"><img src="images/abblogo.svg" alt="Ankara Büyükşehir Belediyesi" title={`v${AppConfig.App.Version}`} decoding="async" /></a></div>
        <a href="https://kentrehberi.ankara.bel.tr" target="_blank" rel="noopener noreferrer" aria-label="Kent Rehberi ana sayfası"><span className="mainbar-text">KENT REHBERİ</span></a>
        <form className="ns-input" role="search" aria-label="Kent Rehberi genel arama" onSubmit={(event) => { event.preventDefault(); openGlobalSearch(); }}>
          <label className="experience-sr-only" htmlFor="kentrehberi-global-search">Adres, yer veya katman ara</label>
          <div className="ns-input-group">
            <input ref={searchInputRef} id="kentrehberi-global-search" type="search" placeholder="Adres, yer veya katman ara…" value={search.query} maxLength={NAVIGATION_SEARCH_QUERY_LIMIT} aria-describedby="kentrehberi-global-search-status" aria-keyshortcuts="Control+K Meta+K" onChange={(event) => searchModel.setQuery(event.target.value)} onCompositionStart={() => searchModel.beginComposition()} onCompositionEnd={(event) => searchModel.endComposition(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Escape') { searchModel.clear(); event.currentTarget.blur(); } }} autoComplete="off" enterKeyHint="search" />
            <button type="submit" className="kr-search-submit" aria-label="Aramayı başlat" title="Ara" disabled={!search.canSubmit}><span className="kr-search-fallback" aria-hidden="true">⌕</span><svg className="kr-search-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg></button>
          </div>
          <span id="kentrehberi-global-search-status" className="experience-sr-only" aria-live="polite" aria-atomic="true">{search.isComposing ? 'Metin girişi sürüyor.' : search.canSubmit ? 'Arama hazır.' : 'Arama için bir ifade yazın.'}</span>
          <span className="kr-search-hint" aria-hidden="true"><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></span>
        </form>
        <nav className="mainbar-right" aria-label="Üst menü">
          <a className="kr-header-shortcut kr-header-portal" href="https://cbsbaskent.ankara.bel.tr" target="_blank" rel="noopener noreferrer" aria-label="CBS Başkent portalını yeni sekmede aç">
            <span aria-hidden="true">CBS Başkent</span>
          </a>
          <CompanyLogo />
        </nav>
      </div></div></div>
    </header>
  );
}

export default NavigationBar;
