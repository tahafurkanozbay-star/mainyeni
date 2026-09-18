import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import {
  createShellCommandRegistry,
  type ShellCommandRegistry,
} from '../../shell/commandRegistryRuntime';
import { EmptyState } from './ExperienceDesignSystem';
import { ExperienceDialog } from './ExperienceDialog';

export interface ExperienceCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly shortcut?: string;
  readonly icon: string;
  readonly target?: string;
  readonly event?: string;
  readonly keywords?: readonly string[];
}

export const EXPERIENCE_COMMANDS = Object.freeze([
  {
    id: 'search',
    label: 'Genel arama',
    group: 'Arama',
    shortcut: 'Ctrl+K',
    icon: 'search',
    target: 'genelarama-query-window',
    keywords: ['ara', 'sorgu'],
  },
  {
    id: 'layers',
    label: 'Katman yönetimini aç',
    group: 'Harita',
    shortcut: 'L',
    icon: 'layers',
    event: 'layers',
    keywords: ['layer'],
  },
  {
    id: 'legend',
    label: 'Lejandı aç',
    group: 'Harita',
    shortcut: 'G',
    icon: 'legend',
    event: 'legend',
    keywords: ['sembol', 'açıklama'],
  },
  {
    id: 'basemap',
    label: 'Altlık haritayı değiştir',
    group: 'Harita',
    icon: 'basemap',
    target: 'basemap-widget',
    keywords: ['taban harita', 'zemin'],
  },
  {
    id: 'identify',
    label: 'Haritada bilgi al',
    group: 'Analiz',
    icon: 'identify',
    target: 'global-identify-widget',
    keywords: ['identify', 'bilgi'],
  },
  {
    id: 'measure',
    label: 'Ölçüm aracını aç',
    group: 'Analiz',
    icon: 'measure',
    target: 'measurement-widget',
    keywords: ['mesafe', 'alan', 'ölç'],
  },
  {
    id: 'sketch',
    label: 'Çizim aracını aç',
    group: 'Analiz',
    icon: 'sketch',
    target: 'sketch-widget',
    keywords: ['çiz', 'geometri'],
  },
  {
    id: 'bookmark',
    label: 'Yer imlerini aç',
    group: 'Harita',
    icon: 'bookmark',
    target: 'bookmark-widget',
    keywords: ['favori', 'konum'],
  },
  {
    id: 'help',
    label: 'Klavye kısayollarını göster',
    group: 'Yardım',
    shortcut: '?',
    icon: 'help',
    event: 'help',
    keywords: ['yardım', 'klavye', 'shortcut'],
  },
] satisfies readonly ExperienceCommandDefinition[]);

export interface ExperienceCommandRegistryDependencies {
  readonly windowManager?: Pick<WindowManagerApi, 'ShowWindow'> | null;
  readonly dispatchCommand?: (name: string) => void;
  readonly dispatchExecuted?: (name: string) => void;
}

const dispatchBrowserCommand = (name: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kentrehberi:command', {
    detail: { name },
  }));
};

const dispatchBrowserExecuted = (name: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kentrehberi:command-executed', {
    detail: { name },
  }));
};

export const createExperienceCommandRegistry = (
  dependencies: ExperienceCommandRegistryDependencies = {},
): ShellCommandRegistry => {
  const registry = createShellCommandRegistry({ capacity: EXPERIENCE_COMMANDS.length });
  const dispatchCommand = dependencies.dispatchCommand ?? dispatchBrowserCommand;
  const dispatchExecuted = dependencies.dispatchExecuted ?? dispatchBrowserExecuted;

  EXPERIENCE_COMMANDS.forEach((definition) => {
    const target = definition.target;
    const event = definition.event;
    registry.register({
      id: definition.id,
      label: definition.label,
      description: definition.group,
      group: definition.group,
      ...(definition.shortcut ? { shortcut: definition.shortcut } : {}),
      ...(definition.keywords ? { keywords: definition.keywords } : {}),
      enabled: () => target ? typeof dependencies.windowManager?.ShowWindow === 'function' : true,
      execute: () => {
        if (target) {
          const opened = dependencies.windowManager?.ShowWindow(target) === true;
          if (!opened) return;
        }
        if (event) dispatchCommand(event);
        dispatchExecuted(definition.id);
      },
    });
  });

  return registry;
};

const definitionById = new Map(EXPERIENCE_COMMANDS.map((command) => [command.id, command]));

const CommandGlyph = ({
  name,
  size = 18,
}: {
  readonly name: string;
  readonly size?: number;
}): ReactNode => {
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
    default: return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
  }
};

export interface ExperienceCommandCenterProps {
  readonly windowManager?: Pick<WindowManagerApi, 'ShowWindow'> | null;
}

interface CommandView {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly shortcut: string | null;
  readonly icon: string;
  readonly enabled: boolean;
}

export function ExperienceCommandCenter({
  windowManager,
}: ExperienceCommandCenterProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const registry = useMemo(
    () => createExperienceCommandRegistry(
      windowManager ? { windowManager } : {},
    ),
    [windowManager],
  );

  useEffect(() => () => registry.destroy(), [registry]);

  const commands = useMemo<readonly CommandView[]>(() => {
    const normalized = query.trim();
    if (!normalized) {
      return EXPERIENCE_COMMANDS.map((definition) => ({
        id: definition.id,
        label: definition.label,
        group: definition.group,
        shortcut: definition.shortcut ?? null,
        icon: definition.icon,
        enabled: definition.target
          ? typeof windowManager?.ShowWindow === 'function'
          : true,
      }));
    }

    return registry.search(normalized).map((match) => ({
      id: match.id,
      label: match.label,
      group: match.group ?? 'Diğer',
      shortcut: match.shortcut,
      icon: definitionById.get(match.id)?.icon ?? match.id,
      enabled: match.enabled,
    }));
  }, [query, registry, windowManager]);

  const activeCommand = commands[activeIndex] ?? null;
  const close = useCallback(() => setOpen(false), []);

  const executeCommand = useCallback(async (command: CommandView | null): Promise<void> => {
    if (!command || !command.enabled) return;
    const executed = await registry.execute(command.id);
    if (executed) close();
  }, [close, registry]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly name?: unknown }>).detail;
      if (detail?.name === 'command-palette') setOpen(true);
    };
    window.addEventListener('kentrehberi:command', handler);
    return () => window.removeEventListener('kentrehberi:command', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (activeIndex < commands.length) return;
    setActiveIndex(Math.max(0, commands.length - 1));
  }, [activeIndex, commands.length]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => commands.length ? (index + 1) % commands.length : 0);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => commands.length ? (index - 1 + commands.length) % commands.length : 0);
      return;
    }
    if (event.key === 'Enter' && activeCommand) {
      event.preventDefault();
      void executeCommand(activeCommand);
    }
  };

  return (
    <ExperienceDialog
      open={open}
      onClose={close}
      labelledBy="kr-command-title"
      describedBy="kr-command-description"
      initialFocusRef={inputRef}
      backdropClassName="kr-command-backdrop"
      dialogClassName="kr-command"
      testId="experience-command-center"
    >
      <header className="kr-command__head">
        <div>
          <span className="experience-eyebrow">KENT REHBERİ</span>
          <h2 id="kr-command-title">Komut merkezi</h2>
          <span id="kr-command-description" className="experience-sr-only">
            Harita, arama ve yardımcı araçlara hızlı erişim.
          </span>
        </div>
        <button
          type="button"
          className="experience-close"
          onClick={close}
          aria-label="Komut merkezini kapat"
        >
          ×
        </button>
      </header>

      <div className="kr-command__search">
        <span aria-hidden="true"><CommandGlyph name="search" size={20} /></span>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleInputKeyDown}
          aria-label="Komut veya işlem ara"
          aria-controls="kr-command-results"
          aria-activedescendant={activeCommand ? `kr-command-item-${activeCommand.id}` : undefined}
          placeholder="Komut veya işlem ara…"
          autoComplete="off"
        />
        <kbd>Ctrl K</kbd>
      </div>

      <div
        id="kr-command-results"
        className="kr-command__body"
        role="listbox"
        aria-label="Komut sonuçları"
      >
        {commands.length ? commands.map((command, index) => (
          <button
            key={command.id}
            id={`kr-command-item-${command.id}`}
            type="button"
            className={`kr-command__item ${index === activeIndex ? 'is-active' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onFocus={() => setActiveIndex(index)}
            onClick={() => { void executeCommand(command); }}
            role="option"
            aria-selected={index === activeIndex}
            aria-disabled={!command.enabled}
            disabled={!command.enabled}
          >
            <span className="kr-command__icon" aria-hidden="true">
              <CommandGlyph name={command.icon} />
            </span>
            <span className="kr-command__copy">
              <strong>{command.label}</strong>
              <small>{command.group}</small>
            </span>
            {command.shortcut
              ? <kbd>{command.shortcut}</kbd>
              : <span aria-hidden="true">↵</span>}
          </button>
        )) : (
          <EmptyState
            title="Komut bulunamadı"
            description="Arama ifadenizi değiştirip tekrar deneyin."
          />
        )}
      </div>

      <footer className="kr-command__foot" aria-live="polite">
        {commands.length} işlem
      </footer>
    </ExperienceDialog>
  );
}

export default ExperienceCommandCenter;
