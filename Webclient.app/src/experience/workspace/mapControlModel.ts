export type MapControlId =
  | 'home'
  | 'zoom-in'
  | 'zoom-out'
  | 'locate'
  | 'layers'
  | 'legend'
  | 'measure'
  | 'fullscreen'
  | 'mode-toggle';

export type MapControlGroup = 'navigation' | 'content' | 'tools' | 'view';
export type MapControlDensity = 'comfortable' | 'compact';
export type MapControlOrientation = 'vertical' | 'horizontal';

export interface MapControlDefinition {
  readonly id: MapControlId;
  readonly group: MapControlGroup;
  readonly label: string;
  readonly shortLabel?: string;
  readonly shortcut?: string;
  readonly requiresGeolocation?: boolean;
  readonly modes?: readonly ('2d' | '3d')[];
  readonly priority: number;
}

export interface MapControlEnvironment {
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly mode: '2d' | '3d';
  readonly geolocationAvailable: boolean;
  readonly fullscreenAvailable: boolean;
}

export interface MapControlState {
  readonly expandedGroup: MapControlGroup | null;
  readonly activeTool: MapControlId | null;
  readonly disabled: ReadonlySet<MapControlId>;
}

export interface MapControlPresentation {
  readonly id: MapControlId;
  readonly label: string;
  readonly group: MapControlGroup;
  readonly shortcut?: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly tabIndex: 0 | -1;
  readonly ariaPressed?: boolean;
}

export interface MapControlSnapshot {
  readonly density: MapControlDensity;
  readonly orientation: MapControlOrientation;
  readonly targetSize: 44 | 48;
  readonly gap: 4 | 6 | 8;
  readonly transitionMs: 0 | 120;
  readonly controls: readonly MapControlPresentation[];
  readonly rovingFocusId: MapControlId;
  readonly expandedGroup: MapControlGroup | null;
  readonly forcedColors: boolean;
}

export interface MapControlModelOptions {
  readonly controls?: readonly MapControlDefinition[];
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: MapControlSnapshot) => void;

export const DEFAULT_MAP_CONTROLS: readonly MapControlDefinition[] = Object.freeze([
  { id: 'home', group: 'navigation', label: 'Başlangıç görünümü', shortLabel: 'Başlangıç', shortcut: 'Alt+H', priority: 100 },
  { id: 'zoom-in', group: 'navigation', label: 'Yakınlaştır', shortcut: '+', priority: 95 },
  { id: 'zoom-out', group: 'navigation', label: 'Uzaklaştır', shortcut: '-', priority: 94 },
  { id: 'locate', group: 'navigation', label: 'Konumumu göster', requiresGeolocation: true, priority: 80 },
  { id: 'layers', group: 'content', label: 'Katmanlar', shortcut: 'Alt+L', priority: 100 },
  { id: 'legend', group: 'content', label: 'Lejant', priority: 80 },
  { id: 'measure', group: 'tools', label: 'Ölçüm araçları', shortLabel: 'Ölçüm', priority: 90 },
  { id: 'fullscreen', group: 'view', label: 'Tam ekran', priority: 70 },
  { id: 'mode-toggle', group: 'view', label: '2B / 3B görünümünü değiştir', shortLabel: '2B / 3B', priority: 100 },
]);

const GROUP_ORDER: readonly MapControlGroup[] = ['navigation', 'content', 'tools', 'view'];
const COMPACT_VISIBLE_LIMIT = 6;

function validateControls(controls: readonly MapControlDefinition[]): void {
  if (controls.length === 0) throw new Error('At least one map control is required.');
  const ids = new Set<MapControlId>();
  for (const control of controls) {
    if (ids.has(control.id)) throw new Error(`Duplicate map control id: ${control.id}`);
    if (!control.label.trim()) throw new Error(`Map control ${control.id} requires a label.`);
    if (!Number.isFinite(control.priority)) throw new Error(`Map control ${control.id} requires a finite priority.`);
    ids.add(control.id);
  }
}

function isEnvironmentHidden(control: MapControlDefinition, environment: MapControlEnvironment): boolean {
  if (control.modes && !control.modes.includes(environment.mode)) return true;
  if (control.id === 'fullscreen' && !environment.fullscreenAvailable) return true;
  return false;
}

function isEnvironmentDisabled(control: MapControlDefinition, environment: MapControlEnvironment): boolean {
  return control.requiresGeolocation === true && !environment.geolocationAvailable;
}

function rankControls(controls: readonly MapControlDefinition[]): readonly MapControlDefinition[] {
  return controls.slice().sort((left, right) => {
    const groupDelta = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group);
    return groupDelta || right.priority - left.priority || left.id.localeCompare(right.id);
  });
}

export class MapControlModel {
  readonly #controls: readonly MapControlDefinition[];
  readonly #listeners = new Set<Listener>();
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  #environment: MapControlEnvironment;
  #state: MapControlState;
  #focusId: MapControlId;
  #snapshot: MapControlSnapshot;

  constructor(environment: MapControlEnvironment, options: MapControlModelOptions = {}) {
    const controls = options.controls ?? DEFAULT_MAP_CONTROLS;
    validateControls(controls);
    this.#controls = rankControls(controls);
    this.#environment = environment;
    this.#onObserverError = options.onObserverError;
    this.#state = { expandedGroup: null, activeTool: null, disabled: new Set<MapControlId>() };
    this.#focusId = this.#controls[0]?.id ?? 'home';
    this.#snapshot = this.#deriveSnapshot();
    this.#repairFocus();
  }

  getSnapshot(): MapControlSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  setEnvironment(environment: MapControlEnvironment): void {
    this.#environment = environment;
    this.#commit();
  }

  setDisabled(id: MapControlId, disabled: boolean): void {
    const next = new Set(this.#state.disabled);
    if (disabled) next.add(id);
    else next.delete(id);
    this.#state = { ...this.#state, disabled: next };
    this.#commit();
  }

  setActiveTool(id: MapControlId | null): void {
    if (id !== null && !this.#controls.some((control) => control.id === id)) return;
    this.#state = { ...this.#state, activeTool: id };
    this.#commit();
  }

  toggleGroup(group: MapControlGroup): void {
    this.#state = {
      ...this.#state,
      expandedGroup: this.#state.expandedGroup === group ? null : group,
    };
    this.#commit();
  }

  focus(id: MapControlId): boolean {
    const target = this.#snapshot.controls.find((control) => control.id === id);
    if (!target || target.hidden || target.disabled) return false;
    this.#focusId = id;
    this.#commit();
    return true;
  }

  moveFocus(direction: 1 | -1): MapControlId {
    const available = this.#snapshot.controls.filter((control) => !control.hidden && !control.disabled);
    if (available.length === 0) return this.#focusId;
    const index = available.findIndex((control) => control.id === this.#focusId);
    const safeIndex = index < 0 ? 0 : index;
    const nextIndex = (safeIndex + direction + available.length) % available.length;
    const next = available[nextIndex];
    if (next) this.#focusId = next.id;
    this.#commit();
    return this.#focusId;
  }

  focusFirst(): MapControlId {
    const first = this.#snapshot.controls.find((control) => !control.hidden && !control.disabled);
    if (first) this.#focusId = first.id;
    this.#commit();
    return this.#focusId;
  }

  focusLast(): MapControlId {
    const available = this.#snapshot.controls.filter((control) => !control.hidden && !control.disabled);
    const last = available.at(-1);
    if (last) this.#focusId = last.id;
    this.#commit();
    return this.#focusId;
  }

  #deriveSnapshot(): MapControlSnapshot {
    const compact = this.#environment.width < 720 || this.#environment.height < 520;
    const orientation: MapControlOrientation = this.#environment.width < 560 ? 'horizontal' : 'vertical';
    const visibleCandidates = this.#controls.filter((control) => !isEnvironmentHidden(control, this.#environment));
    const compactIds = new Set(visibleCandidates.slice(0, COMPACT_VISIBLE_LIMIT).map((control) => control.id));
    compactIds.add('mode-toggle');

    const controls = this.#controls.map<MapControlPresentation>((control) => {
      const hiddenByEnvironment = isEnvironmentHidden(control, this.#environment);
      const hidden = hiddenByEnvironment || (compact && !compactIds.has(control.id) && this.#state.expandedGroup !== control.group);
      const disabled = this.#state.disabled.has(control.id) || isEnvironmentDisabled(control, this.#environment);
      const active = this.#state.activeTool === control.id;
      return Object.freeze({
        id: control.id,
        label: compact ? control.shortLabel ?? control.label : control.label,
        group: control.group,
        ...(control.shortcut ? { shortcut: control.shortcut } : {}),
        active,
        disabled,
        hidden,
        tabIndex: control.id === this.#focusId && !hidden && !disabled ? 0 : -1,
        ...(control.group === 'tools' || control.group === 'content' ? { ariaPressed: active } : {}),
      });
    });

    return Object.freeze({
      density: compact ? 'compact' : 'comfortable',
      orientation,
      targetSize: this.#environment.coarsePointer ? 48 : 44,
      gap: compact ? 4 : this.#environment.coarsePointer ? 8 : 6,
      transitionMs: this.#environment.reducedMotion ? 0 : 120,
      controls: Object.freeze(controls),
      rovingFocusId: this.#focusId,
      expandedGroup: this.#state.expandedGroup,
      forcedColors: this.#environment.forcedColors,
    });
  }

  #repairFocus(): void {
    const current = this.#snapshot.controls.find((control) => control.id === this.#focusId);
    if (current && !current.hidden && !current.disabled) return;
    const replacement = this.#snapshot.controls.find((control) => !control.hidden && !control.disabled);
    if (replacement) this.#focusId = replacement.id;
    this.#snapshot = this.#deriveSnapshot();
  }

  #commit(): void {
    this.#snapshot = this.#deriveSnapshot();
    this.#repairFocus();
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch (error) {
        try {
          this.#onObserverError?.(error);
        } catch (reporterError) {
          void reporterError;
        }
      }
    }
  }
}
