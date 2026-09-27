export type ArcGisLayerLoadPriority = 'critical' | 'visible' | 'prefetch';

export interface ArcGisLayerLoadRequest {
  readonly layerId: string;
  readonly priority: ArcGisLayerLoadPriority;
  readonly estimatedBytes: number;
  readonly signal?: AbortSignal;
}

export interface ArcGisLayerLoadLease {
  readonly layerId: string;
  readonly signal: AbortSignal;
  release(): void;
}

export interface ArcGisLayerLoadSchedulerOptions {
  readonly maxConcurrent: number;
  readonly maxInFlightBytes: number;
  readonly maxQueueDepth: number;
  readonly queueTimeoutMs: number;
  readonly maxEstimatedBytesPerLayer: number;
}

interface QueueEntry {
  readonly request: ArcGisLayerLoadRequest;
  readonly sequence: number;
  readonly enqueuedAt: number;
  readonly resolve: (lease: ArcGisLayerLoadLease) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | undefined;
}

const priorityRank: Readonly<Record<ArcGisLayerLoadPriority, number>> = {
  critical: 0,
  visible: 1,
  prefetch: 2,
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function assertLayerId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) throw new Error('layerId must contain 1..256 characters');
  return normalized;
}

export class ArcGisLayerLoadScheduler {
  private readonly options: ArcGisLayerLoadSchedulerOptions;
  private readonly queue: QueueEntry[] = [];
  private readonly activeLayerIds = new Set<string>();
  private inFlightBytes = 0;
  private sequence = 0;
  private disposed = false;

  constructor(options: ArcGisLayerLoadSchedulerOptions) {
    assertPositiveInteger(options.maxConcurrent, 'maxConcurrent');
    assertPositiveInteger(options.maxInFlightBytes, 'maxInFlightBytes');
    assertPositiveInteger(options.maxQueueDepth, 'maxQueueDepth');
    assertPositiveInteger(options.queueTimeoutMs, 'queueTimeoutMs');
    assertPositiveInteger(options.maxEstimatedBytesPerLayer, 'maxEstimatedBytesPerLayer');
    if (options.maxEstimatedBytesPerLayer > options.maxInFlightBytes) {
      throw new Error('maxEstimatedBytesPerLayer cannot exceed maxInFlightBytes');
    }
    this.options = Object.freeze({ ...options });
  }

  acquire(request: ArcGisLayerLoadRequest): Promise<ArcGisLayerLoadLease> {
    if (this.disposed) return Promise.reject(new Error('ArcGisLayerLoadScheduler is disposed'));
    const layerId = assertLayerId(request.layerId);
    assertPositiveInteger(request.estimatedBytes, 'estimatedBytes');
    if (request.estimatedBytes > this.options.maxEstimatedBytesPerLayer) {
      return Promise.reject(new Error('estimatedBytes exceeds per-layer budget'));
    }
    if (request.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (this.activeLayerIds.has(layerId) || this.queue.some((entry) => entry.request.layerId === layerId)) {
      return Promise.reject(new Error(`layer ${layerId} already has a pending or active load`));
    }
    if (this.canAdmit(request.estimatedBytes) && this.queue.length === 0) {
      return Promise.resolve(this.createLease({ ...request, layerId }));
    }
    if (this.queue.length >= this.options.maxQueueDepth) return Promise.reject(new Error('layer load queue is full'));

    return new Promise<ArcGisLayerLoadLease>((resolve, reject) => {
      const entry: QueueEntry = {
        request: Object.freeze({ ...request, layerId }),
        sequence: this.sequence++,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: undefined,
        abortListener: undefined,
      };
      entry.timer = setTimeout(() => this.removeEntry(entry, new Error('layer load queue timeout')), this.options.queueTimeoutMs);
      if (request.signal) {
        entry.abortListener = () => this.removeEntry(entry, new DOMException('Aborted', 'AbortError'));
        request.signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.sortQueue();
      this.drain();
    });
  }

  snapshot(): Readonly<{ activeCount: number; queuedCount: number; inFlightBytes: number; activeLayerIds: readonly string[] }> {
    return Object.freeze({
      activeCount: this.activeLayerIds.size,
      queuedCount: this.queue.length,
      inFlightBytes: this.inFlightBytes,
      activeLayerIds: Object.freeze([...this.activeLayerIds].sort()),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.queue.splice(0);
    for (const entry of pending) this.cleanupEntry(entry, new Error('ArcGisLayerLoadScheduler is disposed'));
  }

  private canAdmit(bytes: number): boolean {
    return this.activeLayerIds.size < this.options.maxConcurrent && this.inFlightBytes + bytes <= this.options.maxInFlightBytes;
  }

  private createLease(request: ArcGisLayerLoadRequest): ArcGisLayerLoadLease {
    const layerId = assertLayerId(request.layerId);
    this.activeLayerIds.add(layerId);
    this.inFlightBytes += request.estimatedBytes;
    const controller = new AbortController();
    let released = false;
    const upstreamAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', upstreamAbort, { once: true });
    return Object.freeze({
      layerId,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        request.signal?.removeEventListener('abort', upstreamAbort);
        this.activeLayerIds.delete(layerId);
        this.inFlightBytes = Math.max(0, this.inFlightBytes - request.estimatedBytes);
        this.drain();
      },
    });
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => priorityRank[a.request.priority] - priorityRank[b.request.priority] || a.sequence - b.sequence);
  }

  private drain(): void {
    if (this.disposed) return;
    let progressed = true;
    while (progressed && this.queue.length > 0) {
      progressed = false;
      const index = this.queue.findIndex((entry) => this.canAdmit(entry.request.estimatedBytes));
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) return;
      if (entry.request.signal?.aborted) {
        this.cleanupEntry(entry, new DOMException('Aborted', 'AbortError'));
        progressed = true;
        continue;
      }
      this.clearEntryHooks(entry);
      entry.resolve(this.createLease(entry.request));
      progressed = true;
    }
  }

  private removeEntry(entry: QueueEntry, error: Error): void {
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.cleanupEntry(entry, error);
    this.drain();
  }

  private cleanupEntry(entry: QueueEntry, error: Error): void {
    this.clearEntryHooks(entry);
    entry.reject(error);
  }

  private clearEntryHooks(entry: QueueEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.abortListener && entry.request.signal) entry.request.signal.removeEventListener('abort', entry.abortListener);
    entry.timer = undefined;
    entry.abortListener = undefined;
  }
}
