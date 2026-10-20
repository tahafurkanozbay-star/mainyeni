import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppConfig } from '../../Core/AppConfig';
import type { AddressGeocodingResult } from '../../data-services/addressGeocoding';
import { useExperienceTheme } from '../Common/ExperienceDesignSystem';
import { NAVIGATION_SEARCH_QUERY_LIMIT, NavigationSearchModel } from './navigationSearchModel';
import './NavigationBar.css';

export interface NavigationBarProps {
  readonly id?: string;
  readonly onAddressSearch: (query: string, signal: AbortSignal) => Promise<readonly AddressGeocodingResult[]>;
  readonly onAddressSelect: (result: AddressGeocodingResult, signal: AbortSignal) => Promise<void>;
}

type SearchFeedback = Readonly<{
  phase: 'idle' | 'loading' | 'success' | 'error';
  message: string;
}>;

const EMPTY_FEEDBACK: SearchFeedback = Object.freeze({ phase: 'idle', message: '' });

export function NavigationBar({ id, onAddressSearch }: NavigationBarProps) {
  const searchModel = useMemo(() => new NavigationSearchModel(), []);
  const search = useSyncExternalStore(searchModel.subscribe, searchModel.getSnapshot, searchModel.getSnapshot);
  const { theme, toggleTheme } = useExperienceTheme();
  const searchControllerRef = useRef<AbortController | null>(null);
  const searchSequenceRef = useRef(0);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<readonly AddressGeocodingResult[]>([]);
  const [feedback, setFeedback] = useState<SearchFeedback>(EMPTY_FEEDBACK);

  useEffect(() => () => {
    searchControllerRef.current?.abort();
    searchModel.dispose();
  }, [searchModel]);

  const submitAddressSearch = async (): Promise<void> => {
    const query = searchModel.getSubmissionQuery();
    if (query === null || search.isComposing || searching) return;

    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    const requestId = ++searchSequenceRef.current;
    setSearching(true);
    setResults([]);
    setFeedback({ phase: 'loading', message: 'Adres seçenekleri aranıyor…' });

    try {
      const candidates = await onAddressSearch(query, controller.signal);
      if (controller.signal.aborted || requestId !== searchSequenceRef.current) return;
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('Adres bulunamadı. Daha açık bir adres deneyin.');
      }
      setResults(candidates.slice(0, 5));
      setFeedback(EMPTY_FEEDBACK);
    } catch (error) {
      if (controller.signal.aborted || requestId !== searchSequenceRef.current) return;
      setResults([]);
      setFeedback({
        phase: 'error',
        message: error instanceof Error && error.message
          ? error.message
          : 'Adres bulunamadı. Daha açık bir adres deneyin.',
      });
    } finally {
      if (requestId === searchSequenceRef.current) {
        setSearching(false);
        if (searchControllerRef.current === controller) searchControllerRef.current = null;
      }
    }
  };

  const selectAddress = async (result: AddressGeocodingResult): Promise<void> => {
    if (searching) return;
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    const requestId = ++searchSequenceRef.current;
    setSearching(true);
    setResults([]);
    setFeedback({ phase: 'loading', message: 'Konum işaretleniyor…' });

    try {
      await onAddressSelect(result, controller.signal);
      if (controller.signal.aborted || requestId !== searchSequenceRef.current) return;
      // Seçim tamamlandığında başarılı işlem bildirimi veya harita yönlendirmesi gösterilmez.
      setFeedback(EMPTY_FEEDBACK);
    } catch (error) {
      if (controller.signal.aborted || requestId !== searchSequenceRef.current) return;
      setFeedback({
        phase: 'error',
        message: error instanceof Error && error.message
          ? error.message
          : 'Seçilen konum haritada gösterilemedi. Yeniden deneyin.',
      });
    } finally {
      if (requestId === searchSequenceRef.current) {
        setSearching(false);
        if (searchControllerRef.current === controller) searchControllerRef.current = null;
      }
    }
  };

  const changeSearchQuery = (value: string): void => {
    if (searchControllerRef.current) {
      searchControllerRef.current.abort();
      searchControllerRef.current = null;
      searchSequenceRef.current += 1;
      setSearching(false);
    }
    setFeedback(EMPTY_FEEDBACK);
    setResults([]);
    searchModel.setQuery(value);
  };

  const themeLabel = theme === 'dark' ? 'Aydınlık temaya geç' : 'Karanlık temaya geç';

  return (
    <header id={id} className="mainbar-container" style={{ top: 0, insetBlockStart: 0 }} role="banner" aria-label="Kent Rehberi üst gezinme">
      <div className="mainbar">
        <div className="mainbar-brand">
          <div className="mainbar-logo">
            <a href="https://www.ankara.bel.tr/" target="_blank" rel="noopener noreferrer" aria-label="Ankara Büyükşehir Belediyesi ana sayfası">
              <img src="images/abblogo.svg" alt="Ankara Büyükşehir Belediyesi" title={'v' + AppConfig.App.Version} decoding="async" />
            </a>
          </div>
          <a href="./" aria-label="KENT REHBERİ ana sayfası"><span className="mainbar-text">KENT REHBERİ</span></a>
        </div>

        <form
          className="ns-input"
          role="search"
          aria-label="Adres ve yer arama"
          aria-busy={searching || undefined}
          onSubmit={(event) => { event.preventDefault(); void submitAddressSearch(); }}
        >
          <label className="experience-sr-only" htmlFor="kentrehberi-global-search">Ankara'da adres, cadde, mahalle veya yer ara</label>
          <div className="ns-input-group">
            <input
              id="kentrehberi-global-search"
              type="search"
              placeholder="Adres, cadde, mahalle veya yer ara…"
              value={search.query}
              maxLength={NAVIGATION_SEARCH_QUERY_LIMIT}
              aria-describedby="kentrehberi-global-search-status"
              onChange={(event) => changeSearchQuery(event.target.value)}
              onCompositionStart={() => searchModel.beginComposition()}
              onCompositionEnd={(event) => searchModel.endComposition(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.nativeEvent.isComposing && !search.isComposing) {
                  if (results.length > 0) {
                    setResults([]);
                    setFeedback(EMPTY_FEEDBACK);
                  } else {
                    changeSearchQuery('');
                    event.currentTarget.blur();
                  }
                }
              }}
              autoComplete="off"
              enterKeyHint="search"
            />
            <button type="submit" className="kr-search-submit" aria-label="Adres aramasını başlat" title="Adresi bul" disabled={!search.canSubmit || searching}>
              {searching
                ? <span className="kr-search-spinner" aria-hidden="true" />
                : <svg className="kr-search-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>}
            </button>
          </div>
          <span id="kentrehberi-global-search-status" className="experience-sr-only" aria-live="polite" aria-atomic="true">
            {search.isComposing ? 'Metin girişi sürüyor.' : search.canSubmit ? 'Adres araması hazır.' : 'Adres veya yer adı yazın.'}
          </span>
          {feedback.message ? (
            <div
              className={'kr-address-search-feedback kr-address-search-feedback--' + feedback.phase}
              role={feedback.phase === 'error' ? 'alert' : 'status'}
              aria-live={feedback.phase === 'error' ? 'assertive' : 'polite'}
              aria-atomic="true"
            >
              <span>{feedback.message}</span>
            </div>
          ) : null}
          {results.length > 0 ? (
            <div className="kr-address-search-results" role="listbox" aria-label="Adres arama sonuçları">
              <div className="kr-address-search-results-heading">Adres seçenekleri</div>
              {results.map((result, index) => (
                <button
                  key={`${result.latitude}:${result.longitude}:${result.displayName}:${index}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  className="kr-address-search-result"
                  onClick={() => { void selectAddress(result); }}
                  disabled={searching}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                    <path d="M20 10.2c0 5.1-8 11.3-8 11.3S4 15.3 4 10.2a8 8 0 1 1 16 0Z" fill="currentColor" opacity=".14" />
                    <path d="M20 10.2c0 5.1-8 11.3-8 11.3S4 15.3 4 10.2a8 8 0 1 1 16 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                    <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.7" />
                  </svg>
                  <span>{result.displayName}</span>
                </button>
              ))}
            </div>
          ) : null}
        </form>

        <nav className="mainbar-right" aria-label="Üst menü">
          <button
            type="button"
            className="kr-theme-toggle"
            onClick={toggleTheme}
            aria-label={themeLabel}
            title={themeLabel}
          >
            {theme === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.5 15.6A8.5 8.5 0 0 1 8.4 3.5 8.5 8.5 0 1 0 20.5 15.6Z" />
              </svg>
            )}
            <span>{theme === 'dark' ? 'Aydınlık' : 'Karanlık'}</span>
          </button>
          <a className="kr-header-shortcut kr-header-portal" href="https://cbsbaskent.ankara.bel.tr/" target="_blank" rel="noopener noreferrer" aria-label="CBS Başkent portalını yeni sekmede aç">
            <span aria-hidden="true">CBS Başkent</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

export default NavigationBar;
