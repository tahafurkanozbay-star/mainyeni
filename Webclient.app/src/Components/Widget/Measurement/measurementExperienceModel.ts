import {
  MEASUREMENT_TOOLS,
  type MeasurementState,
  type MeasurementTool,
} from '../../../gis-engine/measurementRuntime';

export type MeasurementInputModality = 'unknown' | 'keyboard' | 'pointer';
export type MeasurementExperiencePhase = 'idle' | 'waiting-map' | 'loading' | 'ready' | 'error' | 'destroyed';
export type MeasurementActivityKind = 'opened' | 'tool' | 'clear' | 'retry' | 'error' | 'closed';

export interface MeasurementActivityEntry {
  readonly id: number;
  readonly kind: MeasurementActivityKind;
  readonly tool: MeasurementTool;
  readonly label: string;
}

export interface MeasurementExperienceSnapshot {
  readonly revision: number;
  readonly phase: MeasurementExperiencePhase;
  readonly visible: boolean;
  readonly viewReady: boolean;
  readonly busy: boolean;
  readonly activeTool: MeasurementTool;
  readonly requestedTool: MeasurementTool;
  readonly canClear: boolean;
  readonly canRetry: boolean;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly errorMessage: string | null;
  readonly errorCode: string | null;
  readonly announcement: string;
  readonly guidance: string;
  readonly modality: MeasurementInputModality;
  readonly activity: readonly MeasurementActivityEntry[];
}

export interface MeasurementExperienceDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly observerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastObserverFailureRevision: number | null;
  readonly lastObserverFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MeasurementExperienceModelOptions {
  readonly maxRetries?: number;
  readonly maxObservers?: number;
  readonly historyLimit?: number;
  readonly maxErrorLength?: number;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = () => void;

const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRIES_LIMIT = 6;
const DEFAULT_MAX_OBSERVERS = 32;
const MAX_OBSERVERS_LIMIT = 96;
const DEFAULT_HISTORY_LIMIT = 12;
const MAX_HISTORY_LIMIT = 40;
const DEFAULT_MAX_ERROR_LENGTH = 180;
const MAX_ERROR_LENGTH_LIMIT = 320;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const isControlCode = (value: number): boolean => value < 32 || value === 127;

const stripControlCharacters = (value: string): string => {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    output += codePoint !== undefined && isControlCode(codePoint) ? ' ' : character;
  }
  return output;
};

const sanitizeText = (value: unknown, limit: number): string => {
  if (typeof value !== 'string') return '';
  return stripControlCharacters(value).replace(/\s+/gu, ' ').trim().slice(0, limit);
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return sanitizeText(error.name, 48) || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const normalizeErrorCode = (value: unknown): string | null => {
  const candidate = sanitizeText(value, 48).toUpperCase();
  if (!candidate) return null;
  let normalized = '';
  for (const character of candidate) {
    const codePoint = character.codePointAt(0) ?? 0;
    const asciiUpper = codePoint >= 65 && codePoint <= 90;
    const digit = codePoint >= 48 && codePoint <= 57;
    if (asciiUpper || digit || character === '_' || character === '-') normalized += character;
  }
  return normalized || null;
};

const toolLabel = (tool: MeasurementTool): string => {
  if (tool === MEASUREMENT_TOOLS.AREA) return 'Alan ölçümü';
  if (tool === MEASUREMENT_TOOLS.DISTANCE) return 'Mesafe ölçümü';
  return 'Ölçüm';
};

const guidanceFor = (
  phase: MeasurementExperiencePhase,
  activeTool: MeasurementTool,
  viewReady: boolean,
): string => {
  if (!viewReady || phase === 'waiting-map') {
    return 'Harita görünümü hazırlanıyor. Ölçüm araçları harita hazır olduğunda kullanılabilir.';
  }
  if (phase === 'loading') {
    return 'Ölçüm aracı hazırlanıyor. İşlem tamamlanana kadar harita üzerinde yeni bir ölçüm başlatmayın.';
  }
  if (phase === 'error') {
    return 'Ölçüm aracı başlatılamadı. Bağlantıyı ve harita görünümünü kontrol edip yeniden deneyin.';
  }
  if (activeTool === MEASUREMENT_TOOLS.AREA) {
    return 'Harita üzerinde alanın köşelerini işaretleyin. İşlemi bitirmek için ArcGIS ölçüm denetiminin yönergelerini izleyin.';
  }
  if (activeTool === MEASUREMENT_TOOLS.DISTANCE) {
    return 'Harita üzerinde hattın noktalarını işaretleyin. İşlemi bitirmek için ArcGIS ölçüm denetiminin yönergelerini izleyin.';
  }
  return 'Alan veya mesafe aracını seçin. Klavye ile araç çubuğunda ok tuşlarını kullanabilirsiniz.';
};

const announcementFor = (
  phase: MeasurementExperiencePhase,
  activeTool: MeasurementTool,
  errorMessage: string | null,
): string => {
  if (phase === 'waiting-map') return 'Harita görünümünün hazır olması bekleniyor.';
  if (phase === 'loading') return 'Ölçüm aracı hazırlanıyor.';
  if (phase === 'error') return errorMessage ? `Ölçüm aracı hazırlanamadı. ${errorMessage}` : 'Ölçüm aracı hazırlanamadı.';
  if (phase === 'destroyed') return 'Ölçüm oturumu kapatıldı.';
  if (activeTool === MEASUREMENT_TOOLS.AREA) return 'Alan ölçümü etkin.';
  if (activeTool === MEASUREMENT_TOOLS.DISTANCE) return 'Mesafe ölçümü etkin.';
  return 'Ölçüm araçları hazır.';
};

const runtimePhase = (state: MeasurementState, viewReady: boolean): MeasurementExperiencePhase => {
  if (state.status === 'destroyed') return 'destroyed';
  if (!viewReady) return 'waiting-map';
  if (state.status === 'loading') return 'loading';
  if (state.status === 'error' || state.error) return 'error';
  if (state.status === 'ready') return 'ready';
  return 'idle';
};

const createSnapshot = (input: {
  revision: number;
  phase: MeasurementExperiencePhase;
  visible: boolean;
  viewReady: boolean;
  activeTool: MeasurementTool;
  requestedTool: MeasurementTool;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  errorCode: string | null;
  modality: MeasurementInputModality;
  activity: readonly MeasurementActivityEntry[];
}): MeasurementExperienceSnapshot => Object.freeze({
  revision: input.revision,
  phase: input.phase,
  visible: input.visible,
  viewReady: input.viewReady,
  busy: input.phase === 'loading',
  activeTool: input.activeTool,
  requestedTool: input.requestedTool,
  canClear: input.activeTool !== MEASUREMENT_TOOLS.NONE && input.phase !== 'loading' && input.phase !== 'destroyed',
  canRetry: input.phase === 'error' && input.viewReady && input.retryCount < input.maxRetries,
  retryCount: input.retryCount,
  maxRetries: input.maxRetries,
  errorMessage: input.errorMessage,
  errorCode: input.errorCode,
  announcement: announcementFor(input.phase, input.activeTool, input.errorMessage),
  guidance: guidanceFor(input.phase, input.activeTool, input.viewReady),
  modality: input.modality,
  activity: Object.freeze(input.activity.map((entry) => Object.freeze({ ...entry }))),
});

const initialRuntimeState = (): MeasurementState => ({
  status: 'idle',
  activeTool: MEASUREMENT_TOOLS.NONE,
  error: null,
  createdAt: null,
  clearedAt: null,
  destroyedAt: null,
});

export class MeasurementExperienceModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxRetries: number;
  readonly #maxObservers: number;
  readonly #historyLimit: number;
  readonly #maxErrorLength: number;
  readonly #onObserverError?: (error: unknown) => void;
  #runtimeState = initialRuntimeState();
  #snapshot: MeasurementExperienceSnapshot;
  #diagnostics: MeasurementExperienceDiagnostics;
  #nextActivityId = 1;
  #disposed = false;

  constructor(options: MeasurementExperienceModelOptions = {}) {
    this.#maxRetries = clampInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES_LIMIT);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS_LIMIT);
    this.#historyLimit = clampInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
    this.#maxErrorLength = clampInteger(options.maxErrorLength, DEFAULT_MAX_ERROR_LENGTH, 32, MAX_ERROR_LENGTH_LIMIT);
    this.#onObserverError = options.onObserverError;
    this.#snapshot = createSnapshot({
      revision: 0,
      phase: 'idle',
      visible: false,
      viewReady: false,
      activeTool: MEASUREMENT_TOOLS.NONE,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      retryCount: 0,
      maxRetries: this.#maxRetries,
      errorMessage: null,
      errorCode: null,
      modality: 'unknown',
      activity: [],
    });
    this.#diagnostics = Object.freeze({
      activeObserverCount: 0,
      rejectedObserverCount: 0,
      observerFailureCount: 0,
      reporterFailureCount: 0,
      lastObserverFailureRevision: null,
      lastObserverFailureKind: null,
      disposed: false,
    });
  }

  readonly getSnapshot = (): MeasurementExperienceSnapshot => this.#snapshot;

  readonly getDiagnostics = (): MeasurementExperienceDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxObservers) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  open(viewReady: boolean): void {
    if (this.#disposed) return;
    const phase = runtimePhase(this.#runtimeState, viewReady);
    this.#publish({
      visible: true,
      viewReady,
      phase,
      errorMessage: null,
      errorCode: null,
      retryCount: 0,
      activity: this.#appendActivity('opened', this.#snapshot.activeTool, 'Ölçüm penceresi açıldı.'),
    });
  }

  close(): void {
    if (this.#disposed || !this.#snapshot.visible) return;
    this.#publish({
      visible: false,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      activity: this.#appendActivity('closed', this.#snapshot.activeTool, 'Ölçüm penceresi kapatıldı.'),
    });
  }

  setViewReady(viewReady: boolean): void {
    if (this.#disposed || this.#snapshot.viewReady === viewReady) return;
    const phase = runtimePhase(this.#runtimeState, viewReady);
    this.#publish({
      viewReady,
      phase,
      errorMessage: viewReady ? this.#snapshot.errorMessage : null,
      errorCode: viewReady ? this.#snapshot.errorCode : null,
    });
  }

  requestTool(tool: MeasurementTool): void {
    if (this.#disposed || tool === this.#snapshot.requestedTool) return;
    this.#publish({ requestedTool: tool });
  }

  syncRuntime(state: MeasurementState): void {
    if (this.#disposed) return;
    this.#runtimeState = state;
    const phase = runtimePhase(state, this.#snapshot.viewReady);
    const nextErrorMessage = state.error
      ? sanitizeText(state.error.message, this.#maxErrorLength) || 'Ölçüm işlemi tamamlanamadı.'
      : null;
    const nextErrorCode = state.error ? normalizeErrorCode(state.error.code) : null;
    const changedTool = state.activeTool !== this.#snapshot.activeTool;
    const activity = changedTool
      ? this.#appendActivity(
        state.activeTool === MEASUREMENT_TOOLS.NONE ? 'clear' : 'tool',
        state.activeTool,
        state.activeTool === MEASUREMENT_TOOLS.NONE
          ? 'Ölçüm temizlendi.'
          : `${toolLabel(state.activeTool)} etkinleştirildi.`,
      )
      : this.#snapshot.activity;

    this.#publish({
      phase,
      activeTool: state.activeTool,
      requestedTool: phase === 'loading' ? this.#snapshot.requestedTool : state.activeTool,
      errorMessage: nextErrorMessage,
      errorCode: nextErrorCode,
      retryCount: phase === 'ready' ? 0 : this.#snapshot.retryCount,
      activity,
    });
  }

  beginOperation(tool: MeasurementTool): void {
    if (this.#disposed) return;
    this.#publish({
      requestedTool: tool,
      phase: this.#snapshot.viewReady ? 'loading' : 'waiting-map',
      errorMessage: null,
      errorCode: null,
    });
  }

  recordError(error: unknown, code?: unknown): void {
    if (this.#disposed) return;
    const rawMessage = error instanceof Error ? error.message : error;
    const message = sanitizeText(rawMessage, this.#maxErrorLength) || 'Ölçüm aracı hazırlanırken beklenmeyen bir sorun oluştu.';
    const errorCode = normalizeErrorCode(code ?? (error instanceof Error ? (error as Error & { code?: unknown }).code : null));
    this.#publish({
      phase: this.#snapshot.viewReady ? 'error' : 'waiting-map',
      errorMessage: this.#snapshot.viewReady ? message : null,
      errorCode: this.#snapshot.viewReady ? errorCode : null,
      activity: this.#appendActivity('error', this.#snapshot.requestedTool, 'Ölçüm işlemi hata ile sonuçlandı.'),
    });
  }

  recordRetry(): boolean {
    if (this.#disposed || !this.#snapshot.canRetry) return false;
    const nextRetryCount = this.#snapshot.retryCount + 1;
    this.#publish({
      retryCount: nextRetryCount,
      phase: 'loading',
      errorMessage: null,
      errorCode: null,
      activity: this.#appendActivity('retry', this.#snapshot.requestedTool, `Ölçüm yeniden deneniyor (${nextRetryCount}/${this.#maxRetries}).`),
    });
    return true;
  }

  recordClear(): void {
    if (this.#disposed) return;
    this.#publish({
      activeTool: MEASUREMENT_TOOLS.NONE,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      errorMessage: null,
      errorCode: null,
      phase: this.#snapshot.viewReady ? 'ready' : 'waiting-map',
      activity: this.#appendActivity('clear', MEASUREMENT_TOOLS.NONE, 'Ölçüm temizlendi.'),
    });
  }

  setInputModality(modality: MeasurementInputModality): void {
    if (this.#disposed || this.#snapshot.modality === modality) return;
    this.#publish({ modality });
  }

  reset(): void {
    if (this.#disposed) return;
    this.#runtimeState = initialRuntimeState();
    this.#snapshot = createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'idle',
      visible: false,
      viewReady: false,
      activeTool: MEASUREMENT_TOOLS.NONE,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      retryCount: 0,
      maxRetries: this.#maxRetries,
      errorMessage: null,
      errorCode: null,
      modality: this.#snapshot.modality,
      activity: [],
    });
    this.#notify();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  #publish(patch: Partial<Omit<MeasurementExperienceSnapshot, 'revision' | 'busy' | 'canClear' | 'canRetry' | 'maxRetries' | 'announcement' | 'guidance'>>): void {
    if (this.#disposed) return;
    const next = createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: patch.phase ?? this.#snapshot.phase,
      visible: patch.visible ?? this.#snapshot.visible,
      viewReady: patch.viewReady ?? this.#snapshot.viewReady,
      activeTool: patch.activeTool ?? this.#snapshot.activeTool,
      requestedTool: patch.requestedTool ?? this.#snapshot.requestedTool,
      retryCount: patch.retryCount ?? this.#snapshot.retryCount,
      maxRetries: this.#maxRetries,
      errorMessage: patch.errorMessage === undefined ? this.#snapshot.errorMessage : patch.errorMessage,
      errorCode: patch.errorCode === undefined ? this.#snapshot.errorCode : patch.errorCode,
      modality: patch.modality ?? this.#snapshot.modality,
      activity: patch.activity ?? this.#snapshot.activity,
    });
    this.#snapshot = next;
    this.#notify();
  }

  #appendActivity(kind: MeasurementActivityKind, tool: MeasurementTool, label: string): readonly MeasurementActivityEntry[] {
    const nextEntry: MeasurementActivityEntry = Object.freeze({
      id: this.#nextActivityId,
      kind,
      tool,
      label,
    });
    this.#nextActivityId += 1;
    const entries = this.#snapshot.activity.concat(nextEntry);
    return Object.freeze(entries.slice(Math.max(0, entries.length - this.#historyLimit)));
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordObserverFailure(error);
        this.#reportObserverError(error);
      }
    }
  }

  #reportObserverError(error: unknown): void {
    if (!this.#onObserverError) return;
    try {
      this.#onObserverError(error);
    } catch (reporterError) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        reporterFailureCount: this.#diagnostics.reporterFailureCount + 1,
        lastObserverFailureRevision: this.#snapshot.revision,
        lastObserverFailureKind: `reporter:${classifyFailure(reporterError)}`,
      });
    }
  }

  #recordObserverFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      observerFailureCount: this.#diagnostics.observerFailureCount + 1,
      lastObserverFailureRevision: this.#snapshot.revision,
      lastObserverFailureKind: classifyFailure(error),
    });
  }

  #recordRejectedObserver(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
    });
  }

  #refreshObserverCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: this.#listeners.size,
    });
  }

  #unsubscribe(listener: Listener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#refreshObserverCount();
  }
}

export const createMeasurementExperienceModel = (
  options: MeasurementExperienceModelOptions = {},
): MeasurementExperienceModel => new MeasurementExperienceModel(options);
