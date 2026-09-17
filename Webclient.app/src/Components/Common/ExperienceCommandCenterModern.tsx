import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { WindowManagerLike } from '../../experience/contracts';
import { SIDEBAR_GROUPS, SIDEBAR_ITEMS } from '../App/SidebarCatalog';
import { EmptyState } from './ExperienceDesignSystem';
import { normalizeCommandQuery } from './experience-quality-utils';

type CommandGlyphName = 'search' | 'layers' | 'legend' | 'basemap' | 'identify' | 'measure' | 'sketch' | 'bookmark' | 'help' | 'service';

export interface ExperienceCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly keywords?: string;
  readonly shortcut?: string;
  readonly glyph: CommandGlyphName;
  readonly target?: string;
  readonly event?: string;
}

interface ExperienceCommandCenterProps {
  readonly windowManager: WindowManagerLike;
}

interface ExperienceCommandEventDetail {
  readonly name?: string;
}

const CORE_COMMANDS: readonly ExperienceCommand[] = Object.freeze([
  { id: 'search', label: 'Genel arama', group: 'Arama', description: 'Adres, yer ve katmanlarda arayın', shortcut: 'Ctrl K', glyph: 'search', target: 'genelarama-query-window' },
  { id: 'layers', label: 'Katman yönetimini aç', group: 'Harita', description: 'Harita katmanlarını yönetin', shortcut: 'L', glyph: 'layers', event: 'layers' },
  { id: 'legend', label: 'Lejandı aç', group: 'Harita', description: 'Harita sembollerini inceleyin', shortcut: 'G', glyph: 'legend', event: 'legend' },
  { id: 'basemap', label: 'Altlık haritayı değiştir', group: 'Harita', description: 'Alternatif harita görünümü seçin', glyph: 'basemap', target: 'basemap-widget' },
  { id: 'identify', label: 'Haritada bilgi al', group: 'Analiz', description: 'Harita üzerindeki nesneleri sorgulayın', glyph: 'identify', target: 'global-identify-widget' },
  { id: 'measure', label: 'Ölçüm aracını aç', group: 'Analiz', description: 'Mesafe ve alan ölçün', glyph: 'measure', target: 'measurement-widget' },
  { id: 'sketch', label: 'Çizim aracını aç', group: 'Analiz', description: 'Harita üzerine çizim ekleyin', glyph: 'sketch', target: 'sketch-widget' },
  { id: 'bookmark', label: 'Yer imlerini aç', group: 'Harita', description: 'Kayıtlı konumlara hızlı gidin', glyph: 'bookmark', target: 'bookmark-widget' },
  { id: 'help', label: 'Klavye kısayollarını göster', group: 'Yardım', description: 'Hızlı kullanım rehberini açın', shortcut: '?', glyph: 'help', event: 'help' },
]);

const GROUP_LABELS = new Map<string, string>(
  (SIDEBAR_GROUPS as readonly { readonly id: string; readonly shortLabel: string }[])
    .map(group => [group.id, group.shortLabel]),
);

const SERVICE_COMMANDS: readonly ExperienceCommand[] = Object.freeze(
  (SIDEBAR_ITEMS as readonly {
    readonly group: string;
    readonly label: string;
    readonly windowId: string;
    readonly iconType: string;
  }[]).map(item => ({
    id: `service-${item.windowId}`,
    label: item.label,
    group: `${GROUP_LABELS.get(item.group) ?? item.group} hizmeti`,
    description: 'Kent servisini haritada açın',
    keywords: `${item.iconType} ${item.group} hizmet servis`,
    glyph: 'service' as const,
    target: item.windowId,
  })),
);

export const EXPERIENCE_COMMANDS: readonly ExperienceCommand[] = Object.freeze([
  ...CORE_COMMANDS,
  ...SERVICE_COMMANDS,
]);

const dispatchExperienceCommand = (name: string): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', { detail: { name } }));
};

const commandSearchText = (command: ExperienceCommand): string => normalizeCommandQuery(
  `${command.label} ${command.group} ${command.description} ${command.keywords ?? ''} ${command.id}`,
);

export const filterExperienceCommands = (
  commands: readonly ExperienceCommand[],
  query: string,
): readonly ExperienceCommand[] => {
  const needle = normalizeCommandQuery(query);
  if (!needle) return commands;
  const tokens = needle.split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const searchable = commandSearchText(command);
    return tokens.every(token => searchable.includes(token));
  });
};

const CommandGlyph = ({ name, size = 18 }: { readonly name: CommandGlyphName; readonly size?: number }): ReactNode => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'search': return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>;
    case 'layers': return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></svg>;
    case 'legend': return <svg {...common}><path d="M5 6h2M10 6h9M5 12h2M10 12h9M5 18h2M10 18h9" /></svg>;
    case 'basemap': return <svg {...common}><path d="m4 6 5-3 6 3 5-3v15l-5 3-6-3-5 3V6Z" /><path d="M9 3v15M15 6v15" /></svg>;
    case 'identify': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>;
    case 'measure': return <svg {...common}><path d="m5 19 14-14 2 2L7 21l-2-2Z" /><path d="m13 7 4 4M10 10l2 2M7 13l2 2" /></svg>;
    case 'sketch': return <svg {...common}><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" /><path d="m13.5 7 3.5 3.5M4 20h5" /></svg>;
    case 'bookmark': return <svg {...common}><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-4-6 4V4.5Z" /></svg>;
    case 'help': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.5 2.5 0 1 1 3.8 2.1c-1 .6-1.5 1.1-1.5 2.4M12 17h.01" /></svg>;
    case 'service': return <svg {...common}><path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z" /><path d="M8 20v-6h8v6M9 9h6" /></svg>;
    default: return null;
  }
};

export function ExperienceCommandCenterModern({ windowManager }: ExperienceCommandCenterProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const filtered = useMemo(
    () => filterExperienceCommands(EXPERIENCE_COMMANDS, query),
    [query],
  );
  const activeCommand = filtered[activeIndex];

  const close = useCallback((): void => {
    setOpen(false);
    requestAnimationFrame(() => previousFocusRef.current?.focus());
  }, []);

  const execute = useCallback((command: ExperienceCommand | undefined): void => {
    if (!command) return;
    close();

    if (command.target) windowManager.ShowWindow(command.target);
    if (command.event) dispatchExperienceCommand(command.event);

    window.dispatchEvent(new CustomEvent('kentrehberi:command-executed', {
      detail: { name: command.id },
    }));
  }, [close, windowManager]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandEventDetail>).detail;
      if (detail?.name !== 'command-palette') return;
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener('kentrehberi:command', handler);
    return () => window.removeEventListener('kentrehberi:command', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
    const activeId = filtered[activeIndex]?.id;
    if (open && activeId) {
      document.getElementById(`kr-command-item-${activeId}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, filtered, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex(index => filtered.length ? (index + 1) % filtered.length : 0);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(index => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(Math.max(0, filtered.length - 1));
      } else if (event.key === 'Enter' && document.activeElement === inputRef.current) {
        event.preventDefault();
        execute(activeCommand);
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeCommand, close, execute, filtered.length, open]);

  if (!open) return null;

  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'PageDown') setActiveIndex(index => Math.min(filtered.length - 1, index + 6));
    if (event.key === 'PageUp') setActiveIndex(index => Math.max(0, index - 6));
  };

  return (
    <div className="kr-command-backdrop" role="presentation" onMouseDown={onBackdropMouseDown}>
      <section
        ref={dialogRef}
        className="kr-command kr-command--universal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kr-command-title"
        aria-describedby="kr-command-description"
      >
        <header className="kr-command__head">
          <div>
            <span className="experience-eyebrow">EVRENSEL ERİŞİM</span>
            <h2 id="kr-command-title">Kent Rehberi Komut Merkezi</h2>
            <span id="kr-command-description" className="experience-sr-only">Harita araçları ve tüm kent servislerinde arama yapın.</span>
          </div>
          <button type="button" className="experience-close" onClick={close} aria-label="Komut merkezini kapat">×</button>
        </header>

        <div className="kr-command__search">
          <span aria-hidden="true"><CommandGlyph name="search" size={20} /></span>
          <input
            ref={inputRef}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            aria-label="Komut veya kent hizmeti ara"
            aria-controls="kr-command-results"
            aria-activedescendant={activeCommand ? `kr-command-item-${activeCommand.id}` : undefined}
            placeholder="Araç, işlem veya kent hizmeti ara…"
            autoComplete="off"
          />
          <kbd>Ctrl K</kbd>
        </div>

        <div className="kr-command__scope" aria-hidden="true">
          <span><strong>{CORE_COMMANDS.length}</strong> harita aracı</span>
          <span><strong>{SERVICE_COMMANDS.length}</strong> kent hizmeti</span>
          <span>Tek arama alanı</span>
        </div>

        <div id="kr-command-results" className="kr-command__body" role="listbox" aria-label="Komut sonuçları">
          {filtered.length ? filtered.map((command, index) => (
            <button
              key={command.id}
              id={`kr-command-item-${command.id}`}
              type="button"
              className={`kr-command__item ${index === activeIndex ? 'is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onClick={() => execute(command)}
              role="option"
              aria-selected={index === activeIndex}
            >
              <span className="kr-command__icon" aria-hidden="true"><CommandGlyph name={command.glyph} /></span>
              <span className="kr-command__copy">
                <strong>{command.label}</strong>
                <small>{command.group} · {command.description}</small>
              </span>
              {command.shortcut ? <kbd>{command.shortcut}</kbd> : <span className="kr-command__enter" aria-hidden="true">↵</span>}
            </button>
          )) : (
            <EmptyState title="Sonuç bulunamadı" description="Farklı bir araç, kurum veya hizmet adı deneyin." />
          )}
        </div>

        <footer className="kr-command__foot" aria-live="polite">
          <span>{filtered.length} sonuç</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> gezin · <kbd>Enter</kbd> aç · <kbd>Esc</kbd> kapat</span>
        </footer>
      </section>
    </div>
  );
}

export default ExperienceCommandCenterModern;

