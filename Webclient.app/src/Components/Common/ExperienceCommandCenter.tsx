import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { EmptyState } from './ExperienceDesignSystem';
import {
  EXPERIENCE_COMMANDS,
  createExperienceBus,
  searchExperienceCommands,
  type ExperienceCommandDefinition,
  type ExperienceCommandName,
} from '../../experience/experienceRuntime';

export interface ExperienceWindowManagerLike {
  ShowWindow?: (id: string) => void;
}

export interface ExperienceCommandCenterProps {
  readonly windowManager?: ExperienceWindowManagerLike | null;
}

const WINDOW_TARGETS: Readonly<Partial<Record<ExperienceCommandName, string>>> = Object.freeze({
  search: 'genelarama-query-window',
  basemap: 'basemap-widget',
  identify: 'global-identify-widget',
  measure: 'measurement-widget',
  draw: 'sketch-widget',
  bookmark: 'bookmark-widget',
});

const GROUP_LABELS: Readonly<Record<ExperienceCommandDefinition['group'], string>> = Object.freeze({
  discover: 'Keşfet',
  map: 'Harita',
  data: 'Veri',
  accessibility: 'Erişilebilirlik',
  system: 'Sistem',
});

const shortcutLabel = (command: ExperienceCommandDefinition): string | null =>
  command.shortcut?.join(' ') ?? null;

const CommandGlyph = ({ name }: { readonly name: ExperienceCommandName }): ReactNode => {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (name === 'search') return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>;
  if (name === 'layers') return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></svg>;
  if (name === 'legend') return <svg {...common}><path d="M5 6h2M10 6h9M5 12h2M10 12h9M5 18h2M10 18h9" /></svg>;
  if (name === 'measure') return <svg {...common}><path d="m5 19 14-14 2 2L7 21l-2-2Z" /><path d="m13 7 4 4M10 10l2 2M7 13l2 2" /></svg>;
  if (name === 'draw') return <svg {...common}><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" /><path d="m13.5 7 3.5 3.5M4 20h5" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M8 12h8" /></svg>;
};

export function ExperienceCommandCenter({ windowManager }: ExperienceCommandCenterProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const resultsId = useId();
  const bus = useMemo(() => createExperienceBus(), []);
  const filtered = useMemo(() => searchExperienceCommands(query, EXPERIENCE_COMMANDS, 50), [query]);
  const activeCommand = filtered[activeIndex];

  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => restoreFocusRef.current?.focus());
  }, []);

  const execute = useCallback((command: ExperienceCommandDefinition | undefined) => {
    if (!command) return;
    const target = WINDOW_TARGETS[command.name];
    if (target) windowManager?.ShowWindow?.(target);
    bus.command({ name: command.name, source: 'command-center', timestamp: Date.now() });
    close();
  }, [bus, close, windowManager]);

  useEffect(() => bus.on('kentrehberi:command', detail => {
    if (detail.name !== 'command-palette') return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }), [bus]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [activeIndex, filtered.length]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => filtered.length ? (index + direction + filtered.length) % filtered.length : 0);
      return;
    }
    if (event.key === 'Enter' && document.activeElement === inputRef.current) {
      event.preventDefault();
      execute(activeCommand);
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
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
  };

  if (!open) return null;

  return (
    <div className="kr-command-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="kr-command"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onDialogKeyDown}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="kr-command__head">
          <div><span className="experience-eyebrow">KENT REHBERİ</span><h2 id={titleId}>Komut merkezi</h2><span id={descriptionId} className="experience-sr-only">Harita, arama ve yardımcı araçlara hızlı erişim.</span></div>
          <button type="button" className="experience-close" onClick={close} aria-label="Komut merkezini kapat">×</button>
        </header>
        <div className="kr-command__search">
          <span aria-hidden="true"><CommandGlyph name="search" /></span>
          <input
            ref={inputRef}
            value={query}
            onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
            aria-label="Komut veya işlem ara"
            aria-controls={resultsId}
            aria-activedescendant={activeCommand ? `${resultsId}-${activeCommand.name}` : undefined}
            placeholder="Komut veya işlem ara…"
            autoComplete="off"
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div id={resultsId} className="kr-command__body" role="listbox" aria-label="Komut sonuçları">
          {filtered.length ? filtered.map((command, index) => (
            <button
              key={command.name}
              id={`${resultsId}-${command.name}`}
              type="button"
              className={`kr-command__item ${index === activeIndex ? 'is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onClick={() => execute(command)}
              role="option"
              aria-selected={index === activeIndex}
            >
              <span className="kr-command__icon" aria-hidden="true"><CommandGlyph name={command.name} /></span>
              <span className="kr-command__copy"><strong>{command.label}</strong><small>{GROUP_LABELS[command.group]} · {command.description}</small></span>
              {shortcutLabel(command) ? <kbd>{shortcutLabel(command)}</kbd> : <span aria-hidden="true">↵</span>}
            </button>
          )) : <EmptyState title="Komut bulunamadı" description="Arama ifadenizi değiştirip tekrar deneyin." />}
        </div>
        <footer className="kr-command__foot" aria-live="polite">{filtered.length} işlem</footer>
      </section>
    </div>
  );
}

export default ExperienceCommandCenter;
