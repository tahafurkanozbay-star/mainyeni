export type ArcGisExportFormat = 'pdf' | 'png' | 'jpeg';
export type ArcGisExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ArcGisExportViewMode = '2d' | '3d';

export interface ArcGisExportExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly wkid: number;
}

export interface ArcGisExportJob {
  readonly id: string;
  readonly title: string;
  readonly format: ArcGisExportFormat;
  readonly viewMode: ArcGisExportViewMode;
  readonly extent: ArcGisExportExtent;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
  readonly status: ArcGisExportStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly revision: number;
  readonly resultToken: string | null;
  readonly failureCode: string | null;
}

export interface ArcGisExportPolicy {
  readonly maxJobs: number;
  readonly maxIdLength: number;
  readonly maxTitleLength: number;
  readonly maxResultTokenLength: number;
  readonly maxFailureCodeLength: number;
  readonly maxWidthPx: number;
  readonly maxHeightPx: number;
  readonly maxPixelCount: number;
  readonly minDpi: number;
  readonly maxDpi: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisExportSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly jobs: readonly ArcGisExportJob[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeTime(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}

function boundedText(value: string, maxLength: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
}

function normalizeFormat(value: ArcGisExportFormat): ArcGisExportFormat {
  if (value !== 'pdf' && value !== 'png' && value !== 'jpeg') throw new Error('invalid export format');
  return value;
}

function normalizeViewMode(value: ArcGisExportViewMode): ArcGisExportViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid export view mode');
  return value;
}

function normalizeStatus(value: ArcGisExportStatus): ArcGisExportStatus {
  if (value !== 'queued' && value !== 'running' && value !== 'completed' && value !== 'failed' && value !== 'cancelled') throw new Error('invalid export status');
  return value;
}

function normalizeExtent(value: ArcGisExportExtent): ArcGisExportExtent {
  if (!value || typeof value !== 'object') throw new Error('extent is required');
  const { xmin, ymin, xmax, ymax, wkid } = value;
  if (![xmin, ymin, xmax, ymax].every(Number.isFinite)) throw new Error('extent coordinates must be finite');
  if (xmax <= xmin || ymax <= ymin) throw new Error('extent bounds are inverted or empty');
  if (!Number.isSafeInteger(wkid) || wkid <= 0) throw new Error('wkid must be a positive safe integer');
  return Object.freeze({ xmin, ymin, xmax, ymax, wkid });
}

function isTerminal(status: ArcGisExportStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function canTransition(from: ArcGisExportStatus, to: ArcGisExportStatus): boolean {
  if (from === 'queued') return to === 'running' || to === 'cancelled';
  if (from === 'running') return to === 'completed' || to === 'failed' || to === 'cancelled';
  return false;
}

function freezeJob(job: ArcGisExportJob): ArcGisExportJob {
  return Object.freeze({ ...job, extent: normalizeExtent(job.extent) });
}

/**
 * Primitive-only authority for print/export lifecycle state. Rendering and network
 * transport remain injected ArcGIS adapter responsibilities. This coordinator never
 * retains MapView, SceneView, PrintTask, Graphic, Geometry, AbortController or Blob.
 */
export class ArcGisExportJobCoordinator {
  private readonly policy: ArcGisExportPolicy;
  private readonly jobs = new Map<string, ArcGisExportJob>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisExportPolicy) {
    const minDpi = positiveInteger(policy.minDpi, 'minDpi');
    const maxDpi = positiveInteger(policy.maxDpi, 'maxDpi');
    if (maxDpi < minDpi) throw new Error('maxDpi must be >= minDpi');
    this.policy = Object.freeze({
      maxJobs: positiveInteger(policy.maxJobs, 'maxJobs'),
      maxIdLength: positiveInteger(policy.maxIdLength, 'maxIdLength'),
      maxTitleLength: positiveInteger(policy.maxTitleLength, 'maxTitleLength'),
      maxResultTokenLength: positiveInteger(policy.maxResultTokenLength, 'maxResultTokenLength'),
      maxFailureCodeLength: positiveInteger(policy.maxFailureCodeLength, 'maxFailureCodeLength'),
      maxWidthPx: positiveInteger(policy.maxWidthPx, 'maxWidthPx'),
      maxHeightPx: positiveInteger(policy.maxHeightPx, 'maxHeightPx'),
      maxPixelCount: positiveInteger(policy.maxPixelCount, 'maxPixelCount'),
      minDpi,
      maxDpi,
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  create(input: {
    readonly id: string;
    readonly title: string;
    readonly format: ArcGisExportFormat;
    readonly viewMode: ArcGisExportViewMode;
    readonly extent: ArcGisExportExtent;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly dpi: number;
  }, timestampMs: number): ArcGisExportJob {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedText(input.id, this.policy.maxIdLength, 'export id');
    if (this.jobs.has(id)) throw new Error('export id already exists');
    const widthPx = this.normalizeDimension(input.widthPx, this.policy.maxWidthPx, 'widthPx');
    const heightPx = this.normalizeDimension(input.heightPx, this.policy.maxHeightPx, 'heightPx');
    if (widthPx * heightPx > this.policy.maxPixelCount) throw new Error('export pixel budget exceeded');
    const dpi = positiveInteger(input.dpi, 'dpi');
    if (dpi < this.policy.minDpi || dpi > this.policy.maxDpi) throw new Error('dpi outside configured bounds');
    const job = freezeJob({
      id,
      title: boundedText(input.title, this.policy.maxTitleLength, 'title'),
      format: normalizeFormat(input.format),
      viewMode: normalizeViewMode(input.viewMode),
      extent: normalizeExtent(input.extent),
      widthPx,
      heightPx,
      dpi,
      status: 'queued',
      createdAtMs: now,
      updatedAtMs: now,
      revision: 1,
      resultToken: null,
      failureCode: null,
    });
    this.jobs.set(id, job);
    this.enforceCapacity(id);
    this.activeId = id;
    this.generation += 1;
    return job;
  }

  transition(idValue: string, statusValue: ArcGisExportStatus, timestampMs: number, payload?: {
    readonly resultToken?: string;
    readonly failureCode?: string;
  }): ArcGisExportJob {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedText(idValue, this.policy.maxIdLength, 'export id');
    const current = this.jobs.get(id);
    if (!current) throw new Error('export job does not exist');
    if (now + this.policy.maxClockSkewMs < current.updatedAtMs) throw new Error('stale export transition rejected');
    const status = normalizeStatus(statusValue);
    if (!canTransition(current.status, status)) throw new Error(`invalid export transition ${current.status} -> ${status}`);
    if (status === 'completed' && payload?.failureCode !== undefined) throw new Error('completed export cannot contain failure code');
    if (status === 'failed' && payload?.resultToken !== undefined) throw new Error('failed export cannot contain result token');
    if ((status === 'running' || status === 'cancelled') && (payload?.resultToken !== undefined || payload?.failureCode !== undefined)) throw new Error('non-result export transition cannot contain terminal payload');
    const resultToken = status === 'completed'
      ? boundedText(payload?.resultToken ?? '', this.policy.maxResultTokenLength, 'resultToken')
      : null;
    const failureCode = status === 'failed'
      ? boundedText(payload?.failureCode ?? '', this.policy.maxFailureCodeLength, 'failureCode')
      : null;
    const next = freezeJob({ ...current, status, updatedAtMs: now, revision: current.revision + 1, resultToken, failureCode });
    this.jobs.set(id, next);
    this.activeId = id;
    this.generation += 1;
    return next;
  }

  activate(idValue: string, timestampMs: number): ArcGisExportJob {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const id = boundedText(idValue, this.policy.maxIdLength, 'export id');
    const job = this.jobs.get(id);
    if (!job) throw new Error('export job does not exist');
    if (this.activeId !== id) {
      this.activeId = id;
      this.generation += 1;
    }
    return job;
  }

  remove(idValue: string): boolean {
    this.assertUsable();
    const id = boundedText(idValue, this.policy.maxIdLength, 'export id');
    if (!this.jobs.delete(id)) return false;
    if (this.activeId === id) this.activeId = null;
    this.generation += 1;
    return true;
  }

  snapshot(timestampMs: number): ArcGisExportSnapshot {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const jobs = [...this.jobs.values()]
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))
      .map(freezeJob);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, jobs: Object.freeze(jobs) });
  }

  restore(snapshot: Pick<ArcGisExportSnapshot, 'activeId' | 'jobs'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.jobs) || snapshot.jobs.length > this.policy.maxJobs) throw new Error('export snapshot exceeds capacity');
    const staged = new Map<string, ArcGisExportJob>();
    for (const source of snapshot.jobs) {
      const id = boundedText(source.id, this.policy.maxIdLength, 'export id');
      if (staged.has(id)) throw new Error('duplicate export id');
      const createdAtMs = nonNegativeTime(source.createdAtMs, 'createdAtMs');
      const updatedAtMs = nonNegativeTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < createdAtMs) throw new Error('export update precedes creation');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future export snapshot rejected');
      const status = normalizeStatus(source.status);
      if (isTerminal(status) && now - updatedAtMs > this.policy.retentionMs) continue;
      const widthPx = this.normalizeDimension(source.widthPx, this.policy.maxWidthPx, 'widthPx');
      const heightPx = this.normalizeDimension(source.heightPx, this.policy.maxHeightPx, 'heightPx');
      if (widthPx * heightPx > this.policy.maxPixelCount) throw new Error('export pixel budget exceeded');
      const dpi = positiveInteger(source.dpi, 'dpi');
      if (dpi < this.policy.minDpi || dpi > this.policy.maxDpi) throw new Error('dpi outside configured bounds');
      const resultToken = source.resultToken === null ? null : boundedText(source.resultToken, this.policy.maxResultTokenLength, 'resultToken');
      const failureCode = source.failureCode === null ? null : boundedText(source.failureCode, this.policy.maxFailureCodeLength, 'failureCode');
      if (status === 'completed' && (resultToken === null || failureCode !== null)) throw new Error('completed export has invalid terminal payload');
      if (status === 'failed' && (failureCode === null || resultToken !== null)) throw new Error('failed export has invalid terminal payload');
      if ((status === 'queued' || status === 'running' || status === 'cancelled') && (resultToken !== null || failureCode !== null)) throw new Error('active export has terminal payload');
      staged.set(id, freezeJob({
        id,
        title: boundedText(source.title, this.policy.maxTitleLength, 'title'),
        format: normalizeFormat(source.format),
        viewMode: normalizeViewMode(source.viewMode),
        extent: normalizeExtent(source.extent),
        widthPx,
        heightPx,
        dpi,
        status,
        createdAtMs,
        updatedAtMs,
        revision: positiveInteger(source.revision, 'revision'),
        resultToken,
        failureCode,
      }));
    }
    let activeId: string | null = null;
    if (snapshot.activeId !== null) {
      activeId = boundedText(snapshot.activeId, this.policy.maxIdLength, 'active export id');
      if (!staged.has(activeId)) throw new Error('active export is missing');
    }
    this.jobs.clear();
    for (const [id, job] of staged) this.jobs.set(id, job);
    this.activeId = activeId;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobs.clear();
    this.activeId = null;
  }

  private normalizeDimension(value: number, maximum: number, name: string): number {
    const normalized = positiveInteger(value, name);
    if (normalized > maximum) throw new Error(`${name} outside configured bounds`);
    return normalized;
  }

  private prune(now: number): void {
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (!isTerminal(job.status) || now - job.updatedAtMs <= this.policy.retentionMs) continue;
      this.jobs.delete(id);
      if (this.activeId === id) this.activeId = null;
      changed = true;
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedId: string): void {
    while (this.jobs.size > this.policy.maxJobs) {
      const candidates = [...this.jobs.values()]
        .filter(job => job.id !== protectedId)
        .sort((a, b) => Number(isTerminal(b.status)) - Number(isTerminal(a.status)) || a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id));
      const victim = candidates[0];
      if (!victim) throw new Error('export capacity cannot be satisfied');
      this.jobs.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisExportJobCoordinator is disposed');
  }
}
