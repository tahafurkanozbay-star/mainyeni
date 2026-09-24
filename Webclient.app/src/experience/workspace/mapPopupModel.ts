export type PopupStatus = 'idle' | 'loading' | 'ready' | 'error';
export type PopupPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right';

export interface PopupFieldInput {
  readonly id: string;
  readonly label: string;
  readonly value: string | number | boolean | null;
  readonly format?: 'text' | 'number' | 'boolean' | 'date';
  readonly hidden?: boolean;
}

export interface PopupFeatureInput {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly fields?: readonly PopupFieldInput[];
  readonly layerId?: string;
  readonly layerLabel?: string;
}

export interface PopupPreferences {
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
  readonly compact?: boolean;
}

export interface PopupFieldView {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface PopupFeatureView {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly layerId: string | undefined;
  readonly layerLabel: string | undefined;
  readonly fields: readonly PopupFieldView[];
}

export interface PopupSnapshot {
  readonly revision: number;
  readonly open: boolean;
  readonly status: PopupStatus;
  readonly features: readonly PopupFeatureView[];
  readonly activeIndex: number;
  readonly activeFeature: PopupFeatureView | undefined;
  readonly featureCount: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly placement: PopupPlacement;
  readonly targetSize: number;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly compact: boolean;
  readonly errorMessage: string | undefined;
  readonly restoreFocusTarget: string | undefined;
}

export interface PopupAnnouncement {
  readonly message: string;
  readonly priority: 'polite' | 'assertive';
}

export interface MapPopupOptions {
  readonly preferences?: PopupPreferences;
  readonly placement?: PopupPlacement;
  readonly onAnnouncement?: (announcement: PopupAnnouncement) => void;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: PopupSnapshot) => void;

const formatValue = (field: PopupFieldInput): string => {
  if (field.value === null) return '—';
  if (field.format === 'boolean' || typeof field.value === 'boolean') return field.value === true ? 'Evet' : 'Hayır';
  if (field.format === 'number' && typeof field.value === 'number') return new Intl.NumberFormat('tr-TR').format(field.value);
  if (field.format === 'date') {
    const date = new Date(String(field.value));
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' }).format(date);
  }
  return String(field.value);
};

const normalizeFeature = (input: PopupFeatureInput): PopupFeatureView => {
  const id = input.id.trim();
  const title = input.title.trim();
  if (!id || !title) throw new Error('Popup feature id and title must be non-empty.');
  const seen = new Set<string>();
  const fields: PopupFieldView[] = [];
  for (const field of input.fields ?? []) {
    if (field.hidden === true) continue;
    const fieldId = field.id.trim();
    const label = field.label.trim();
    if (!fieldId || !label) throw new Error('Popup field id and label must be non-empty.');
    if (seen.has(fieldId)) throw new Error(`Duplicate popup field id: ${fieldId}`);
    seen.add(fieldId);
    fields.push(Object.freeze({ id: fieldId, label, value: formatValue(field) }));
  }
  return Object.freeze({
    id,
    title,
    subtitle: input.subtitle?.trim() || undefined,
    layerId: input.layerId?.trim() || undefined,
    layerLabel: input.layerLabel?.trim() || undefined,
    fields: Object.freeze(fields),
  });
};

export class MapPopupModel {
  readonly #listeners = new Set<Listener>();
  readonly #onAnnouncement: ((announcement: PopupAnnouncement) => void) | undefined;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #placement: PopupPlacement;
  readonly #targetSize: number;
  readonly #reducedMotion: boolean;
  readonly #forcedColors: boolean;
  readonly #compact: boolean;
  #features: readonly PopupFeatureView[] = Object.freeze([]);
  #activeIndex = 0;
  #status: PopupStatus = 'idle';
  #errorMessage: string | undefined;
  #restoreFocusTarget: string | undefined;
  #revision = 0;
  #snapshot: PopupSnapshot;

  constructor(options: MapPopupOptions = {}) {
    this.#placement = options.placement ?? 'auto';
    this.#targetSize = options.preferences?.coarsePointer === true ? 48 : 40;
    this.#reducedMotion = options.preferences?.reducedMotion ?? false;
    this.#forcedColors = options.preferences?.forcedColors ?? false;
    this.#compact = options.preferences?.compact ?? false;
    this.#onAnnouncement = options.onAnnouncement;
    this.#onObserverError = options.onObserverError;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): PopupSnapshot { return this.#snapshot; }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    this.#notifyOne(listener);
    return () => this.#listeners.delete(listener);
  }

  open(features: readonly PopupFeatureInput[], options: { readonly activeId?: string; readonly restoreFocusTarget?: string } = {}): void {
    if (features.length > 100) throw new RangeError('Popup supports at most 100 features.');
    const normalized = features.map(normalizeFeature);
    const ids = new Set<string>();
    for (const feature of normalized) {
      if (ids.has(feature.id)) throw new Error(`Duplicate popup feature id: ${feature.id}`);
      ids.add(feature.id);
    }
    this.#features = Object.freeze(normalized);
    const requestedIndex = options.activeId ? normalized.findIndex((feature) => feature.id === options.activeId) : 0;
    this.#activeIndex = requestedIndex >= 0 ? requestedIndex : 0;
    this.#restoreFocusTarget = options.restoreFocusTarget?.trim() || undefined;
    this.#status = normalized.length > 0 ? 'ready' : 'idle';
    this.#errorMessage = undefined;
    this.#commit();
    if (normalized.length > 0) this.#announce(this.#featureAnnouncement(), 'polite');
  }

  close(): string | undefined {
    if (this.#status === 'idle' && this.#features.length === 0) return this.#restoreFocusTarget;
    const restoreTarget = this.#restoreFocusTarget;
    this.#features = Object.freeze([]);
    this.#activeIndex = 0;
    this.#status = 'idle';
    this.#errorMessage = undefined;
    this.#restoreFocusTarget = undefined;
    this.#commit();
    this.#announce('Detay penceresi kapatıldı.', 'polite');
    return restoreTarget;
  }

  setLoading(restoreFocusTarget?: string): void {
    this.#features = Object.freeze([]);
    this.#activeIndex = 0;
    this.#status = 'loading';
    this.#errorMessage = undefined;
    this.#restoreFocusTarget = restoreFocusTarget?.trim() || this.#restoreFocusTarget;
    this.#commit();
    this.#announce('Detaylar yükleniyor.', 'polite');
  }

  setError(message: string): void {
    const normalized = message.trim();
    if (!normalized) throw new Error('Popup error message must be non-empty.');
    this.#features = Object.freeze([]);
    this.#activeIndex = 0;
    this.#status = 'error';
    this.#errorMessage = normalized;
    this.#commit();
    this.#announce(normalized, 'assertive');
  }

  next(): void {
    if (this.#features.length < 2) return;
    this.#activeIndex = (this.#activeIndex + 1) % this.#features.length;
    this.#commit();
    this.#announce(this.#featureAnnouncement(), 'polite');
  }

  previous(): void {
    if (this.#features.length < 2) return;
    this.#activeIndex = (this.#activeIndex - 1 + this.#features.length) % this.#features.length;
    this.#commit();
    this.#announce(this.#featureAnnouncement(), 'polite');
  }

  first(): void {
    if (this.#features.length === 0 || this.#activeIndex === 0) return;
    this.#activeIndex = 0;
    this.#commit();
    this.#announce(this.#featureAnnouncement(), 'polite');
  }

  last(): void {
    const lastIndex = this.#features.length - 1;
    if (lastIndex < 0 || this.#activeIndex === lastIndex) return;
    this.#activeIndex = lastIndex;
    this.#commit();
    this.#announce(this.#featureAnnouncement(), 'polite');
  }

  activate(id: string): void {
    const index = this.#features.findIndex((feature) => feature.id === id);
    if (index < 0 || index === this.#activeIndex) return;
    this.#activeIndex = index;
    this.#commit();
    this.#announce(this.#featureAnnouncement(), 'polite');
  }

  #featureAnnouncement(): string {
    const feature = this.#features[this.#activeIndex];
    if (!feature) return '';
    return this.#features.length === 1
      ? `${feature.title} detayı açıldı.`
      : `${feature.title}. ${this.#activeIndex + 1} / ${this.#features.length}.`;
  }

  #buildSnapshot(): PopupSnapshot {
    const activeFeature = this.#features[this.#activeIndex];
    return Object.freeze({
      revision: this.#revision,
      open: this.#status !== 'idle',
      status: this.#status,
      features: this.#features,
      activeIndex: this.#activeIndex,
      activeFeature,
      featureCount: this.#features.length,
      canPrevious: this.#features.length > 1,
      canNext: this.#features.length > 1,
      placement: this.#placement,
      targetSize: this.#targetSize,
      reducedMotion: this.#reducedMotion,
      forcedColors: this.#forcedColors,
      compact: this.#compact,
      errorMessage: this.#errorMessage,
      restoreFocusTarget: this.#restoreFocusTarget,
    });
  }

  #commit(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) this.#notifyOne(listener);
  }

  #notifyOne(listener: Listener): void {
    try { listener(this.#snapshot); } catch (error) { this.#reportObserverError(error); }
  }

  #announce(message: string, priority: PopupAnnouncement['priority']): void {
    if (!this.#onAnnouncement) return;
    try { this.#onAnnouncement({ message, priority }); } catch (error) { this.#reportObserverError(error); }
  }

  #reportObserverError(error: unknown): void {
    if (!this.#onObserverError) return;
    try { this.#onObserverError(error); } catch (reportingError) { void reportingError; }
  }
}
