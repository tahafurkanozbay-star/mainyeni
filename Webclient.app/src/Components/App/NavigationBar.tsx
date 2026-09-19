import { useState } from 'react';
import { AppConfig } from '../../Core/AppConfig';
import type { UnknownRecord } from '../../Business/contracts';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { CompanyLogo } from './CompanyLogo';
import './NavigationBar.css';

interface SearchQuery extends UnknownRecord {
  name: string;
}

export interface NavigationBarProps {
  readonly id?: string;
  readonly windowManager: Pick<WindowManagerApi, 'ShowWindow'>;
}

export function NavigationBar({ windowManager }: NavigationBarProps) {
  const [query, setQuery] = useState<SearchQuery>({ name: '' });

  const openGlobalSearch = (): void => {
    windowManager.ShowWindow('genelarama-query-window', { ...query });
  };

  return (
    <header className="mainbar-container" role="banner" aria-label="Kent Rehberi üst gezinme">
      <div className="row h-100">
        <div className="col-12 h-100">
          <div className="mainbar">
            <div className="mainbar-logo">
              <a
                href="https://www.ankara.bel.tr/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Ankara Büyükşehir Belediyesi ana sayfası"
              >
                <img
                  src="images/abblogo.svg"
                  alt="Ankara Büyükşehir Belediyesi"
                  title={`v${AppConfig.App.Version}`}
                  decoding="async"
                />
              </a>
            </div>
            <a
              href="https://kentrehberi.ankara.bel.tr"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Kent Rehberi ana sayfası"
            >
              <span className="mainbar-text">KENT REHBERİ</span>
            </a>
            <form
              className="ns-input"
              role="search"
              aria-label="Kent Rehberi genel arama"
              onSubmit={(event) => {
                event.preventDefault();
                openGlobalSearch();
              }}
            >
              <label className="experience-sr-only" htmlFor="kentrehberi-global-search">
                Adres, yer veya katman ara
              </label>
              <div className="ns-input-group">
                <input
                  id="kentrehberi-global-search"
                  type="search"
                  placeholder="Adres, yer veya katman ara…"
                  value={query.name}
                  onChange={(event) => setQuery({ name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setQuery({ name: '' });
                      event.currentTarget.blur();
                    }
                  }}
                  autoComplete="off"
                  enterKeyHint="search"
                />
                <button type="submit" className="kr-search-submit" aria-label="Aramayı başlat" title="Ara">
                  <span className="kr-search-fallback" aria-hidden="true">⌕</span>
                  <svg
                    className="kr-search-icon"
                    width="19"
                    height="19"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-4-4" />
                  </svg>
                </button>
              </div>
              <span className="kr-search-hint" aria-hidden="true">
                <kbd>Ctrl</kbd><span>+</span><kbd>K</kbd>
              </span>
            </form>
            <div className="mainbar-right" aria-label="Üst menü">
              <CompanyLogo />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export default NavigationBar;
