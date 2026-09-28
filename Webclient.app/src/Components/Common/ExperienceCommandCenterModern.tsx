import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { SIDEBAR_GROUPS, SIDEBAR_ITEMS } from '../App/SidebarCatalog';
import {
  createCommandCenterInteractionModel,
  type CommandCenterItem,
} from '../../experience/commandCenterInteractionModel';
import { createCommandCenterAccessibilityController } from '../../experience/commandCenterAccessibilityController';
import { createCommandCenterUsageModel } from '../../experience/commandCenterUsageModel';
import {
  createCommandCenterScopeModel,
  type CommandCenterConcreteScope,
  type CommandCenterScopeId,
} from '../../experience/commandCenterScopeModel';
import { createCommandCenterRenderWindow } from '../../experience/commandCenterRenderWindow';
import {
  assertCommandCenterCatalog,
  type CommandCenterCatalogReport,
} from '../../experience/commandCenterCatalogAudit';
import { createFocusScope } from '../../experience/focusScopeRuntime';
import { acquireOverlayLease } from '../../experience/overlayLifecycleRuntime';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import { EmptyState } from './ExperienceDesignSystem';
import { normalizeCommandQuery } from './experience-quality-utils';
import './experience-command-center.css';

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
  readonly disabled?: boolean;
  readonly scopes?: readonly CommandCenterConcreteScope[];
}

interface ExperienceCommandCenterProps {
  readonly windowManager: Pick<WindowManagerApi, 'ShowWindow'>;
}

interface ExperienceCommandEventDetail {
  readonly name?: string;
}

const CORE_COMMANDS: readonly ExperienceCommand[] = Object.freeze([
  { id: 'search', label: 'Genel arama', group: 'Arama', description: 'Adres, yer ve katmanlarda arayın', shortcut: 'Ctrl K', glyph: 'search', target: 'genelarama-query-window', scopes: ['map'] },
  { id: 'layers', label: 'Katman yönetimini aç', group: 'Harita', description: 'Harita katmanlarını yönetin', shortcut: 'L', glyph: 'layers', event: 'layers', scopes: ['map'] },
  { id: 'legend', label: 'Lejandı aç', group: 'Harita', description: 'Harita sembollerini inceleyin', shortcut: 'G', glyph: 'legend', event: 'legend', scopes: ['map'] },
  { id: 'basemap', label: 'Altlık haritayı değiştir', group: 'Harita', description: 'Alternatif harita görünümü seçin', glyph: 'basemap', target: 'basemap-widget', scopes: ['map'] },
  { id: 'identify', label: 'Haritada bilgi al', group: 'Analiz', description: 'Harita üzerindeki nesneleri sorgulayın', glyph: 'identify', target: 'global-identify-widget', scopes: ['analysis', 'map'] },
  { id: 'measure', label: 'Ölçüm aracını aç', group: 'Analiz', description: 'Mesafe ve alan ölçün', glyph: 'measure', target: 'measurement-widget', scopes: ['analysis', 'map'] },
  { id: 'sketch', label: 'Çizim aracını aç', group: 'Analiz', description: 'Harita üzerine çizim ekleyin', glyph: 'sketch', target: 'sketch-widget', scopes: ['analysis', 'map'] },
  { id: 'bookmark', label: 'Yer imlerini aç', group: 'Harita', description: 'Kayıtlı konumlara hızlı gidin', glyph: 'bookmark', target: 'bookmark-widget', scopes: ['map'] },
  { id: 'help', label: 'Klavye kısayollarını göster', group: 'Yardım', description: 'Hızlı kullanım rehberini açın', shortcut: '?', glyph: 'help', event: 'help', scopes: ['help'] },
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
    scopes: Object.freeze(['services'] as const),
  })),
);

export const EXPERIENCE_COMMANDS: readonly ExperienceCommand[] = Object.freeze([
  ...CORE_COMMANDS,
  ...SERVICE_COMMANDS,
]);

export const COMMAND_CENTER_CATALOG_REPORT: CommandCenterCatalogReport = assertCommandCenterCatalog(
  EXPERIENCE_COMMANDS,
);

const commandById = new Map(EXPERIENCE_COMMANDS.map(command => [command.id, command]));

export const toCommandCenterItem = (command: ExperienceCommand): CommandCenterItem => Object.freeze({
  id: command.id,
  group: command.group,
  label: command.label,
  description: command.description,
  searchText: `${command.label} ${command.group} ${command.description} ${command.keywords ?? ''} ${command.id}`,
  ...(command.disabled === true ? { disabled: true } : {}),
});

const MODEL_ITEMS = Object.freeze(EXPERIENCE_COMMANDS.map(toCommandCenterItem));
const SCOPE_ITEMS = Object.freeze(EXPERIENCE_COMMANDS.map(command => Object.freeze({
  id: command.id,
  scopes: command.scopes ?? Object.freeze(['map'] as const),
})));

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

const reportCommandCenterError = (error: unknown, source: string): void => {
  runtimeDiagnostics.captureError(error, { source }, 'warn');
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

const scopeLabels: Readonly<Record<CommandCenterScopeId, string>> = Object.freeze({
  all: 'Tümü',
  map: 'Harita',
  analysis: 'Analiz',
  services: 'Hizmetler',
  help: 'Yardım',
});

export function ExperienceCommandCenterModern({ windowManager }: ExperienceCommandCenterProps): ReactNode {
  const model = useMemo(() => createCommandCenterInteractionModel(MODEL_ITEMS, {
    pageStep: 6,
    onObserverError: error => reportCommandCenterError(error, 'experience.command-center.model-observer'),
  }), []);
  const controller = useMemo(
    () => createCommandCenterAccessibilityController(model, 'kr-command'),
    [model],
  );
  const usage = useMemo(() => createCommandCenterUsageModel({
    maxTracked: 64,
    recentLimit: 6,
    frequentLimit: 6,
    onObserverError: error => reportCommandCenterError(error, 'experience.command-center.usage-observer'),
  }), []);
  const scopes = useMemo(() => createCommandCenterScopeModel(SCOPE_ITEMS, {
    maxItems: 512,
    onObserverError: error => reportCommandCenterError(error, 'experience.command-center.scope-observer'),
  }), []);

  const subscribeModel = useCallback((notify: () => void) => model.subscribe(() => notify()), [model]);
  const subscribeUsage = useCallback((notify: () => void) => usage.subscribe(() => notify()), [usage]);
  const subscribeScope = useCallback((notify: () => void) => scopes.subscribe(() => notify()), [scopes]);
  const state = useSyncExternalStore(subscribeModel, model.getState, model.getState);
  const usageSnapshot = useSyncExternalStore(subscribeUsage, usage.snapshot, usage.snapshot);
  const scopeSnapshot = useSyncExternalStore(subscribeScope, scopes.snapshot, scopes.snapshot);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const accessibility = useMemo(() => controller.snapshot(), [controller, state]);
  const renderWindow = useMemo(
    () => createCommandCenterRenderWindow(state, { maxRendered: 18, overscan: 2 }),
    [state],
  );

  const scopedInventory = useCallback((scope: CommandCenterScopeId): readonly CommandCenterItem[] => {
    const visible = new Set(scopes.setScope(scope).visibleIds);
    const source = MODEL_ITEMS.filter(item => visible.has(item.id));
    return usage.prioritize(source, item => item.id);
  }, [scopes, usage]);

  const applyScope = useCallback((scope: CommandCenterScopeId): void => {
    const prioritized = scopedInventory(scope);
    model.dispatch({ type: 'items-changed', items: prioritized });
  }, [model, scopedInventory]);

  const close = useCallback((modality: 'keyboard' | 'pointer' | 'programmatic' = 'programmatic'): void => {
    controller.close(modality);
  }, [controller]);

  const executeById = useCallback((id: string | null): void => {
    if (!id) return;
    const command = commandById.get(id);
    if (!command || command.disabled) return;

    usage.record(command.id);
    const activeScope = scopes.snapshot().activeScope;
    applyScope(activeScope);
    controller.close('programmatic');

    if (command.target) windowManager.ShowWindow(command.target);
    if (command.event) dispatchExperienceCommand(command.event);
    window.dispatchEvent(new CustomEvent('kentrehberi:command-executed', {
      detail: { name: command.id },
    }));
  }, [applyScope, controller, scopes, usage, windowManager]);

  useEffect(() => () => {
    model.dispose();
    usage.dispose();
    scopes.dispose();
  }, [model, scopes, usage]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandEventDetail>).detail;
      if (detail?.name !== 'command-palette') return;
      scopes.setScope('all');
      const prioritized = usage.prioritize(MODEL_ITEMS, item => item.id);
      model.dispatch({ type: 'items-changed', items: prioritized });
      controller.open('programmatic');
    };
    window.addEventListener('kentrehberi:command', handler);
    return () => window.removeEventListener('kentrehberi:command', handler);
  }, [controller, model, scopes, usage]);

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
      onEscape: () => close('keyboard'),
      onFocusError: error => reportCommandCenterError(error, 'experience.command-center.focus'),
    });
    focusScope.activate();
    return () => {
      focusScope.dispose();
      overlay.release();
    };
  }, [close, state.open]);

  useEffect(() => {
    if (!state.open || !state.activeId) return;
    const active = document.getElementById(`kr-command-item-${state.activeId}`);
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [state.activeId, state.open]);

  useEffect(() => {
    if (!state.open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const result = controller.handleKey(event);
      if (result.intent.type === 'execute') executeById(result.intent.commandId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, executeById, state.open]);

  const onQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
    controller.query(event.target.value, 'keyboard');
  };

  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close('pointer');
  };

  const onScope = (scope: CommandCenterScopeId): void => {
    if (scope === scopeSnapshot.activeScope) return;
    applyScope(scope);
    inputRef.current?.focus();
  };

  if (!state.open) return null;

  const activeCommand = state.activeId ? commandById.get(state.activeId) : undefined;
  const renderedMatches = renderWindow.options
    .map(option => state.matches[option.absoluteIndex])
    .filter((match): match is NonNullable<typeof match> => Boolean(match));

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
          <button type="button" className="experience-close" onClick={() => close('pointer')} aria-label="Komut merkezini kapat">×</button>
        </header>

        <div className="kr-command__search">
          <span aria-hidden="true"><CommandGlyph name="search" size={20} /></span>
          <input
            ref={inputRef}
            id={accessibility.inputId}
            role="combobox"
            value={state.query}
            onChange={onQueryChange}
            aria-label="Komut veya kent hizmeti ara"
            aria-controls={accessibility.listboxId}
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-activedescendant={accessibility.activeDescendant ?? undefined}
            aria-autocomplete="list"
            placeholder="Araç, işlem veya kent hizmeti ara…"
            autoComplete="off"
          />
          <kbd>Ctrl K</kbd>
        </div>

        <nav className="kr-command__scope kr-command__scope--interactive" aria-label="Komut kapsamı">
          {(Object.keys(scopeLabels) as CommandCenterScopeId[]).map(scope => (
            <button
              key={scope}
              type="button"
              className={scope === scopeSnapshot.activeScope ? 'is-active' : ''}
              aria-pressed={scope === scopeSnapshot.activeScope}
              onClick={() => onScope(scope)}
            >
              <span>{scopeLabels[scope]}</span>
              <strong>{scopeSnapshot.counts[scope]}</strong>
            </button>
          ))}
        </nav>

        <div id={accessibility.statusId} className="experience-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.announcement}
        </div>

        <div
          id={accessibility.listboxId}
          className="kr-command__body"
          role="listbox"
          aria-label="Komut sonuçları"
          aria-describedby={accessibility.statusId}
        >
          {renderWindow.hiddenBefore > 0 ? (
            <div className="kr-command__window-hint" aria-hidden="true">↑ {renderWindow.hiddenBefore} önceki sonuç</div>
          ) : null}
          {renderedMatches.length ? renderedMatches.map(match => {
            const command = commandById.get(match.item.id);
            const option = renderWindow.options.find(entry => entry.commandId === match.item.id);
            if (!command || !option) return null;
            const selected = state.activeId === command.id;
            return (
              <button
                key={command.id}
                id={`kr-command-item-${command.id}`}
                type="button"
                className={`kr-command__item ${selected ? 'is-active' : ''}`}
                onMouseEnter={() => controller.activate(command.id, 'pointer')}
                onFocus={() => controller.activate(command.id, 'pointer')}
                onClick={() => executeById(command.id)}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                aria-posinset={option.position}
                aria-setsize={option.setSize}
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
            <EmptyState title="Eşleşen komut bulunamadı" description="Daha kısa bir ifade deneyin veya farklı bir araç adı yazın." />
          )}
          {renderWindow.hiddenAfter > 0 ? (
            <div className="kr-command__window-hint" aria-hidden="true">↓ {renderWindow.hiddenAfter} sonraki sonuç</div>
          ) : null}
        </div>

        <footer className="kr-command__footer">
          <span aria-hidden="true">↑↓ gezin · PgUp/PgDn hızlı gezin · Enter aç · Esc kapat</span>
          <span className="kr-command__usage" aria-label={`${usageSnapshot.trackedCount} komut bu oturumda kullanıldı`}>
            {usageSnapshot.lastExecutedId ? `Son: ${commandById.get(usageSnapshot.lastExecutedId)?.label ?? usageSnapshot.lastExecutedId}` : 'Oturum geçmişi boş'}
          </span>
          <strong>{activeCommand?.group ?? `${state.matches.length} sonuç`}</strong>
        </footer>
      </section>
    </div>
  );
}

export default ExperienceCommandCenterModern;
