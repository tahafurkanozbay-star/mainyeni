import React, { useRef, useState } from 'react';
import { NavigationBar } from './NavigationBar';
import type { AddressGeocodingResult } from '../../data-services/addressGeocoding';
import type { ExperienceMapMode } from '../../experience/experienceRuntime';
import './AtlasSiteInterface.css';

interface AtlasSiteInterfaceProps {
  readonly mode: ExperienceMapMode;
  readonly onModeChange: (mode: ExperienceMapMode) => void;
  readonly onAddressSearch: (query: string, signal: AbortSignal) => Promise<readonly AddressGeocodingResult[]>;
  readonly onAddressSelect: (result: AddressGeocodingResult, signal: AbortSignal) => Promise<void>;
  readonly onOpenDirections: () => void;
  readonly directionsOpen: boolean;
  readonly onCommand: (command: string) => void;
  readonly onOpenExplore: () => void;
  readonly onLocate: () => void;
  readonly onBasemap: () => void;
  readonly onMeasure: () => void;
  readonly exploreOpen: boolean;
}

export function AtlasSiteInterface({ mode, onModeChange, onAddressSearch, onAddressSelect, onOpenDirections, directionsOpen, onCommand, onOpenExplore, onLocate, onBasemap, onMeasure, exploreOpen }: AtlasSiteInterfaceProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="atlas-site" aria-label="Kent Rehberi harita araçları">
      <a className="atlas-site__brand" href="#esri-map-container" aria-label="Kent Rehberi haritaya dön">
        <span className="atlas-site__brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M16 2.8 27.7 9.5v13L16 29.2 4.3 22.5v-13L16 2.8Z"/><path d="m16 2.8 5.8 9.9L16 29.2 10.2 12.7 16 2.8Z"/><circle cx="16" cy="16" r="2.1"/></svg></span>
        <span className="atlas-site__brand-name">kent<span>atlası</span></span>
      </a>

      <div className="atlas-site__search" ref={searchRef}>
        <NavigationBar id="mainbar" onAddressSearch={onAddressSearch} onAddressSelect={onAddressSelect} onOpenDirections={onOpenDirections} directionsOpen={directionsOpen} />
      </div>

      <button type="button" className="atlas-site__route" aria-label="Yol tarifi" aria-expanded={directionsOpen} onClick={onOpenDirections}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.4 7-13a7 7 0 1 0-14 0c0 6.6 7 13 7 13Z"/><circle cx="12" cy="9" r="2.2"/></svg><span>Yol tarifi</span></button>

      <nav className="atlas-site__dock" aria-label="Harita kısayolları">
        <button type="button" className={`atlas-site__button${exploreOpen ? ' is-active' : ''}`} aria-label="Keşfet" title="Keşfet" aria-expanded={exploreOpen} onClick={onOpenExplore}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5h7v7H4zM13 4.5h7v7h-7zM4 13.5h7v7H4zM13 13.5h7v7h-7z"/></svg></button>
        <button type="button" className="atlas-site__button" aria-label="Konumumu bul" title="Konumumu bul" onClick={onLocate}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
        <span className="atlas-site__divider" />
        <button type="button" className="atlas-site__button" aria-label="Altlık haritalar" title="Altlık haritalar" onClick={onBasemap}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 4.5-1 5 2 4.5-1V5l-4.5 1-5-2L5 5v14Z"/><path d="M9.5 3.8V18M14.5 6v14"/></svg></button>
        <button type="button" className="atlas-site__button" aria-label="Ölçüm araçları" title="Ölçüm araçları" onClick={onMeasure}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 12-12 4 4L8 20H4v-4Z"/><path d="m13 7 4 4M10 10l2 2M7 13l2 2"/></svg></button>
        <button type="button" className={`atlas-site__button${toolsOpen ? ' is-active' : ''}`} aria-label="Yakınlaştırma" aria-expanded={toolsOpen} title="Yakınlaştırma" onClick={() => setToolsOpen((open) => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 5 5M10.8 7.8v6M7.8 10.8h6"/></svg></button>
        <span className="atlas-site__divider" />
        <div className="atlas-site__modes" role="group" aria-label="Harita boyutu">
          <button type="button" className={mode === '2d' ? 'is-selected' : ''} aria-pressed={mode === '2d'} onClick={() => onModeChange('2d')}>2B</button>
          <button type="button" className={mode === '3d' ? 'is-selected' : ''} aria-pressed={mode === '3d'} onClick={() => onModeChange('3d')}>3B</button>
        </div>
      </nav>

      {toolsOpen ? (
        <div className="atlas-site__tool-popover" role="group" aria-label="Harita işlemleri">
          <button type="button" onClick={() => onCommand('map-zoom-in')} aria-label="Yakınlaştır"><span aria-hidden="true">＋</span>Yakınlaştır</button>
          <button type="button" onClick={() => onCommand('map-zoom-out')} aria-label="Uzaklaştır"><span aria-hidden="true">−</span>Uzaklaştır</button>
          <button type="button" onClick={() => onCommand('map-home')} aria-label="Başlangıç görünümü"><span aria-hidden="true">⌂</span>Başlangıç görünümü</button>
        </div>
      ) : null}

      <div className="atlas-site__scale" aria-hidden="true"><span className="atlas-site__scale-line"/><span>ANKARA <i>·</i> TÜRKİYE</span></div>
    </div>
  );
}
