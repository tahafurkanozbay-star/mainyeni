import type { ViewState, ViewStateInput } from '../../gis-engine/contracts';
import { createViewState } from '../../gis-engine/viewState';
import type { ExperienceMapMode } from '../../experience/experienceRuntime';

export type MapViewportContinuityStatus = 'unknown' | 'preserved' | 'degraded';
export type MapViewportContinuitySeverity = 'info' | 'warning';
export type MapViewportContinuityFindingCode =
  | 'mode-mismatch'
  | 'center-lost'
  | 'center-introduced'
  | 'scale-lost'
  | 'scale-ratio-high'
  | 'basemap-changed'
  | 'selection-layer-changed'
  | 'selection-object-changed'
  | 'time-changed';

export interface MapViewportContinuityFinding {
  readonly code: MapViewportContinuityFindingCode;
  readonly severity: MapViewportContinuitySeverity;
  readonly message: string;
}

export interface MapViewportContinuityReport {
  readonly requestId: number;
  readonly sourceMode: ExperienceMapMode;
  readonly targetMode: ExperienceMapMode;
  readonly status: MapViewportContinuityStatus;
  readonly score: number;
  readonly findings: readonly MapViewportContinuityFinding[];
  readonly source: ViewState;
  readonly target: ViewState;
  readonly assessedAtMs: number;
}

export interface MapViewportContinuitySnapshot {
  readonly revision: number;
  readonly status: MapViewportContinuityStatus;
  readonly latestReport: MapViewportContinuityReport | null;
  readonly preservedCount: number;
  readonly degradedCount: number;
  readonly announcement: string;
  readonly recentReports: readonly MapViewportContinuityReport[];
}

export interface MapViewportContinuityDiagnostics {
  readonly listenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly assessmentCount: number;
  readonly boundedReportCount: number;
  readonly disposed: boolean;
}

export interface MapViewportContinuityOptions {
  readonly maxListeners?: number;
  readonly maxReports?: number;
  readonly maximumScaleRatio?: number;
  readonly now?: () => number;
}

type Listener = () => void;

const DEFAULT_MAX_LISTENERS = 24;
const MAX_LISTENERS = 100;
const DEFAULT_MAX_REPORTS = 8;
const MAX_REPORTS = 24;
const DEFAULT_MAX_SCALE_RATIO = 8;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const clampRatio = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SCALE_RATIO;
  return Math.max(1.5, Math.min(100, Number(value)));
};

const freezeFinding = (
  code: MapViewportContinuityFindingCode,
  severity: MapViewportContinuitySeverity,
  message: string,
): MapViewportContinuityFinding => Object.freeze({ code, severity, message });

const sameNullable = (left: unknown, right: unknown): boolean => {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
};

const comparableScale = (state: ViewState): number | null => {
  if (Number.isFinite(state.scale) && Number(state.scale) > 0) return Number(state.scale);
  if (Number.isFinite(state.zoom)) {
    const zoom = Math.max(0, Math.min(32, Number(state.zoom)));
    return 591657527.591555 / (2 ** zoom);
  }
  return null;
};

const scaleRatio = (left: number, right: number): number => {
  const high = Math.max(left, right);
  const low = Math.max(Number.EPSILON, Math.min(left, right));
  return high / low;
};

const scoreFor = (findings: readonly MapViewportContinuityFinding[]): number => {
  let score = 100;
  for (const finding of findings) score -= finding.severity === 'warning' ? 18 : 5;
  return Math.max(0, score);
};

const announcementFor = (status: MapViewportContinuityStatus, report: MapViewportContinuityReport | null): string => {
  if (!report || status === 'unknown') return 'Görünüm sürekliliği henüz değerlendirilmedi.';
  if (status === 'preserved') return 'Harita konumu ve çalışma bağlamı görünüm geçişinde korundu.';
  const warningCount = report.findings.filter((finding) => finding.severity === 'warning').length;
  return warningCount > 0
    ? `Görünüm geçişi tamamlandı; ${warningCount} konum veya bağlam farkı algılandı.`
    : 'Görünüm geçişi tamamlandı; küçük bağlam farkları algılandı.';
};

export const assessMapViewportContinuity = (
  sourceInput: ViewStateInput | ViewState,
  targetInput: ViewStateInput | ViewState,
  expectedMode: ExperienceMapMode,
  maximumScaleRatio = DEFAULT_MAX_SCALE_RATIO,
  requestId = 0,
  assessedAtMs = Date.now(),
): MapViewportContinuityReport => {
  const source = createViewState(sourceInput);
  const target = createViewState(targetInput);
  const findings: MapViewportContinuityFinding[] = [];
  const ratioLimit = clampRatio(maximumScaleRatio);

  if (target.mode !== expectedMode) {
    findings.push(freezeFinding('mode-mismatch', 'warning', `Beklenen ${expectedMode} görünüm modu uygulanmadı.`));
  }
  if (source.center && !target.center) {
    findings.push(freezeFinding('center-lost', 'warning', 'Harita merkezi görünüm geçişinde kayboldu.'));
  } else if (!source.center && target.center) {
    findings.push(freezeFinding('center-introduced', 'info', 'Hedef görünüm yeni bir merkez değeri üretti.'));
  }

  const sourceScale = comparableScale(source);
  const targetScale = comparableScale(target);
  if (sourceScale !== null && targetScale === null) {
    findings.push(freezeFinding('scale-lost', 'warning', 'Harita ölçeği görünüm geçişinde kayboldu.'));
  } else if (sourceScale !== null && targetScale !== null && scaleRatio(sourceScale, targetScale) > ratioLimit) {
    findings.push(freezeFinding('scale-ratio-high', 'warning', 'Hedef görünüm ölçeği kaynak görünümden belirgin biçimde uzaklaştı.'));
  }

  if (!sameNullable(source.basemapId, target.basemapId)) {
    findings.push(freezeFinding('basemap-changed', 'warning', 'Altlık harita kimliği görünüm geçişinde değişti.'));
  }
  if (!sameNullable(source.selectedLayerId, target.selectedLayerId)) {
    findings.push(freezeFinding('selection-layer-changed', 'warning', 'Seçili katman görünüm geçişinde değişti.'));
  }
  if (!sameNullable(source.selectedObjectId, target.selectedObjectId)) {
    findings.push(freezeFinding('selection-object-changed', 'warning', 'Seçili nesne görünüm geçişinde değişti.'));
  }
  if (!sameNullable(source.time, target.time)) {
    findings.push(freezeFinding('time-changed', 'info', 'Zaman bağlamı görünüm geçişinde değişti.'));
  }

  const score = scoreFor(findings);
  const status: MapViewportContinuityStatus = findings.some((finding) => finding.severity === 'warning')
    ? 'degraded'
    : 'preserved';

  return Object.freeze({
    requestId,
    sourceMode: source.mode,
    targetMode: target.mode,
    status,
    score,
    findings: Object.freeze(findings),
    source: Object.freeze(source),
    target: Object.freeze(target),
    assessedAtMs: Number.isFinite(assessedAtMs) ? assessedAtMs : Date.now(),
  });
};

const initialSnapshot = (): MapViewportContinuitySnapshot => Object.freeze({
  revision: 0,
  status: 'unknown',
  latestReport: null,
  preservedCount: 0,
  degradedCount: 0,
  announcement: 'Görünüm sürekliliği henüz değerlendirilmedi.',
  recentReports: Object.freeze([]),
});

export class MapViewportContinuityModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxListeners: number;
  readonly #maxReports: number;
  readonly #maximumScaleRatio: number;
  readonly #now: () => number;
  #snapshot = initialSnapshot();
  #diagnostics: MapViewportContinuityDiagnostics = Object.freeze({
    listenerCount: 0,
    rejectedListenerCount: 0,
    listenerFailureCount: 0,
    assessmentCount: 0,
    boundedReportCount: 0,
    disposed: false,
  });
  #disposed = false;

  constructor(options: MapViewportContinuityOptions = {}) {
    this.#maxListeners = clampInteger(options.maxListeners, DEFAULT_MAX_LISTENERS, 1, MAX_LISTENERS);
    this.#maxReports = clampInteger(options.maxReports, DEFAULT_MAX_REPORTS, 1, MAX_REPORTS);
    this.#maximumScaleRatio = clampRatio(options.maximumScaleRatio);
    this.#now = options.now ?? (() => Date.now());
  }

  readonly getSnapshot = (): MapViewportContinuitySnapshot => this.#snapshot;
  readonly getDiagnostics = (): MapViewportContinuityDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#patchDiagnostics({ rejectedListenerCount: this.#diagnostics.rejectedListenerCount + 1 });
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxListeners) {
      this.#patchDiagnostics({ rejectedListenerCount: this.#diagnostics.rejectedListenerCount + 1 });
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#patchDiagnostics({ listenerCount: this.#listeners.size });
    return () => this.#unsubscribe(listener);
  };

  assess(
    requestId: number,
    source: ViewStateInput | ViewState,
    target: ViewStateInput | ViewState,
    expectedMode: ExperienceMapMode,
  ): MapViewportContinuityReport | null {
    if (this.#disposed) return null;
    const report = assessMapViewportContinuity(
      source,
      target,
      expectedMode,
      this.#maximumScaleRatio,
      requestId,
      this.#safeNow(),
    );
    const reports = Object.freeze([...this.#snapshot.recentReports, report].slice(-this.#maxReports));
    const boundedReportCount = Math.max(0, this.#diagnostics.assessmentCount + 1 - reports.length);
    const next: MapViewportContinuitySnapshot = Object.freeze({
      revision: this.#snapshot.revision + 1,
      status: report.status,
      latestReport: report,
      preservedCount: this.#snapshot.preservedCount + (report.status === 'preserved' ? 1 : 0),
      degradedCount: this.#snapshot.degradedCount + (report.status === 'degraded' ? 1 : 0),
      announcement: announcementFor(report.status, report),
      recentReports: reports,
    });
    this.#snapshot = next;
    this.#patchDiagnostics({
      assessmentCount: this.#diagnostics.assessmentCount + 1,
      boundedReportCount,
    });
    this.#notify();
    return report;
  }

  reset(): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({ ...initialSnapshot(), revision: this.#snapshot.revision + 1 });
    this.#notify();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#patchDiagnostics({ listenerCount: 0, disposed: true });
  }

  #safeNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? value : Date.now();
  }

  #unsubscribe(listener: Listener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#patchDiagnostics({ listenerCount: this.#listeners.size });
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        const kind = error instanceof Error ? error.name : typeof error;
        void kind;
        this.#patchDiagnostics({ listenerFailureCount: this.#diagnostics.listenerFailureCount + 1 });
      }
    }
  }

  #patchDiagnostics(patch: Partial<MapViewportContinuityDiagnostics>): void {
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, ...patch });
  }
}

export const createMapViewportContinuityModel = (
  options: MapViewportContinuityOptions = {},
): MapViewportContinuityModel => new MapViewportContinuityModel(options);
