import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { SIDEBAR_GROUPS, SIDEBAR_ITEMS } from '../App/SidebarCatalog';
import {
  createCommandCenterInteractionModel,
  type CommandCenterAction,
  type CommandCenterItem,
  type CommandCenterState,
} from '../../experience/commandCenterInteractionModel';
import { createFocusScope } from '../../experience/focusScopeRuntime';
import { acquireOverlayLease } from '../../experience/overlayLifecycleRuntime';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import { EmptyState } from './ExperienceDesignSystem';

export type GovernedCommandGlyphName =
  | 'search'
  | 'layers'
  | 'legend'
  | 'basemap'
  | 'identify'
  | 'measure'
  | 'sketch'
  | 'bookmark'
  | 'help'
  | 'service';

export interface GovernedExperienceCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly keywords?: string;
  readonly shortcut?: string;
  readonly glyph: GovernedCommandGlyphName;
  readonly target?: string;
  readonly event?: string;
  readonly disabled?: boolean;
}

interface ExperienceCommandCenterGovernedProps {
  readonly windowManager: Pick<WindowManagerApi, 'ShowWindow'>;
}

interface ExperienceCommandEventDetail {
  readonly name?: string;
}

const CORE_COMMANDS: readonly GovernedExperienceCommand[] = Object.freeze([
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
    .map((group) => [group.id, group.shortLabel]),
);

const SERVICE_COMMANDS: readonly GovernedExperienceCommand[] = Object.freeze(
  (SIDEBAR_ITEMS as readonly {
    readonly group: string;
    readonly label: string;
    readonly windowId: string;
    readonly iconType: string;
  }[]).map((item) => ({
    id: `service-${item.windowId}`,
    label: item.label,
    group: `${GROUP_LABELS.get(item.group) ?? item.group} hizmeti`,
    description: 'Kent servisini haritada açın',
    keywords: `${item.iconType} ${item.group} hizmet servis`,
    glyph: 'service' as const,
    target: item.windowId,
  })),
);

export const GOVERNED_EXPERIENCE_COMMANDS: readonly GovernedExperienceCommand[] = Object.freeze([
  ...CORE_COMMANDS,
  ...SERVICE_COMMANDS,
]);

const commandById = new Map(GOVERNED_EXPERIENCE_COMMANDS.map((command) => [command.id, command]));

export const toCommandCenterItem = (command: GovernedExperienceCommand): CommandCenterItem => Object.freeze({
  id: command.id,
  group: command.group,
  label: command.label,
  description: command.description,
  searchText: `${command.label} ${command.group} ${command.description} ${command.keywords ?? ''} ${command.id}`,
  ...(command.disabled === true ? { disabled: true } : {}),
});

const MODEL_ITEMS = Object.freeze(GOVERNED_EXPERIENCE_COMMANDS.map(toCommandCenterItem));

const dispatchExperienceCommand = (name: string): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', { detail: { name } }));
};

const CommandGlyph = ({ name, size = 18 }: { readonly name: GovernedCommandGlyphName; readonly size?: number }): ReactNode => {
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
  }
};

export function ExperienceCommandCenterGoverned({ windowManager }: ExperienceCommandCenterGovernedProps): ReactNode {
  const model = useMemo(() => createCommandCenterInteractionModel(MODEL_ITEMS), []);
  const [state, setState] = useState<CommandCenterState>(() => model.getState());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  const dispatch = useCallback((action: CommandCenterAction): CommandCenterState => {
    const next = model.dispatch(action);
    setState(next);
    return next;
  }, [model]);

  const close = useCallback((): void => {
    dispatch({ type: 'close', modality: 'programmatic' });
  }, [dispatch]);

  const executeById = useCallback((id: string | null): void => {
    if (!id) return;
    const command = commandById.get(id);
    if (!command || command.disabled) return;
    dispatch({ type: 'close', modality: 'programmatic' });
    if (command.target) windowManager.ShowWindow(command.target);
    if (command.event) dispatchExperienceCommand(command.event);
    window.dispatchEvent(new CustomEvent('kentrehberi:command-executed', { detail: { name: command.id } }));
  }, [dispatch, windowManager]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandEventDetail>).detail;
      if (detail?.name !== 'command-palette') return;
      dispatch({ type: 'open', modality: 'programmatic' });
    };
    window.addEventListener('kentrehberi:command', handler);
    return () => window.removeEventListener('kentrehberi:command', handler);
  }, [dispatch]);

  useEffect(() => {
    if (!state.open || !dialogRef.current) return undefined;
    const overlay = acquireOverlayLease({
      document,
      id: 'experience-command-center',
      modal: true,
      lockScroll: true,
      root: backdropRef.current,
    });
    const focusScope = createFocusScope({
      document,
      container: dialogRef.current,
      initialFocus: inputRef.current,
      onEscape: close,
      onFocusError(error) {
        runtimeDiagnostics.captureError(error, { source: 'experience.command-center.focus' }, 'warn');
      },
    });
    focusScope.activate();
    return () => {
      focusScope.dispose();
      overlay.release();
    };
  }, [close, state.open]);

  useEffect(() => {
    if (!state.open || !state.activeId) return;
    document.getElementById(`kr-command-item-${state.activeId}`)?.scrollIntoView({ block: 'nearest' });
  }, [state.activeId, state.open]);

  useEffect(() => {
    if (!state.open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      let action: CommandCenterAction | null = null;
      if (event.key === 'ArrowDown') action = { type: 'move', delta: 1, modality: 'keyboard' };
      else if (event.key === 'ArrowUp') action = { type: 'move', delta: -1, modality: 'keyboard' };
      else if (event.key === 'Home') action = { type: 'first', modality: 'keyboard' };
      else if (event.key === 'End') action = { type: 'last', modality: 'keyboard' };
      else if (event.key === 'PageDown') action = { type: 'page-forward', modality: 'keyboard' };
      else if (event.key === 'PageUp') action = { type: 'page-backward', modality: 'keyboard' };
      else if (event.key === 'Enter' && document.activeElement === inputRef.current) {
        event.preventDefault();
        executeById(model.getState().activeId);
        return;
      }
      if (!action) return;
      event.preventDefault();
      dispatch(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch, executeById, model, state.open]);

  const onQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
    dispatch({ type: 'query', value: event.target.value, modality: 'keyboard' });
  };

  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) dispatch({ type: 'close', modality: 'pointer' });
  };

  const activatePointerItem = (id: string): void => {
    dispatch({ type: 'activate', id, modality: 'pointer' });
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') event.stopPropagation();
  };

  if (!state.open) return null;

  const activeCommand = state.activeId ? commandById.get(state.activeId) : undefined;

  return (
    <div ref={backdropRef} className="kr-command-backdrop" role="presentation" onMouseDown={onBackdropMouseDown}>
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
            value={state.query}
            onChange={onQueryChange}
            onKeyDown={onInputKeyDown}
            aria-label="Komut veya kent hizmeti ara"
            aria-controls="kr-command-results"
            aria-activedescendant={state.activeId ? `kr-command-item-${state.activeId}` : undefined}
            aria-autocomplete="list"
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

        <div className="experience-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.announcement}
        </div>

        <div id="kr-command-results" className="kr-command__body" role="listbox" aria-label="Komut sonuçları">
          {state.matches.length ? state.matches.map((match) => {
            const command = commandById.get(match.item.id);
            if (!command) return null;
            const selected = state.activeId === command.id;
            return (
              <button
                key={command.id}
                id={`kr-command-item-${command.id}`}
                type="button"
                className={`kr-command__item ${selected ? 'is-active' : ''}`}
                onMouseEnter={() => activatePointerItem(command.id)}
                onFocus={() => activatePointerItem(command.id)}
                onClick={() => executeById(command.id)}
                role="option"
                aria-selected={selected}
              >
                <span className="kr-command__icon" aria-hidden="true"><CommandGlyph name={command.glyph} /></span>
                <span className="kr-command__copy">
                  <strong>{command.label}</strong>
                  <small>{command.group} · {command.description}</small>
                </span>
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : <span className="kr-command__enter" aria-hidden="true">↵</span>}
              </button>
            );
          }) : (
            <EmptyState
              title="Eşleşen komut bulunamadı"
              description="Daha kısa bir ifade deneyin veya farklı bir araç adı yazın."
            />
          )}
        </div>

        <footer className="kr-command__footer" aria-hidden="true">
          <span>↑↓ gezin</span>
          <span>PgUp/PgDn hızlı gezin</span>
          <span>Enter aç</span>
          <span>Esc kapat</span>
          {activeCommand ? <strong>{activeCommand.group}</strong> : null}
        </footer>
      </section>
    </div>
  );
}
