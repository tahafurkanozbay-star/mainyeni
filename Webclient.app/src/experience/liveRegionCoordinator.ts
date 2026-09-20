export type AnnouncementPoliteness = "polite" | "assertive";
export type AnnouncementPriority = "low" | "normal" | "high";

export interface AnnouncementRequest {
    message: string;
    politeness?: AnnouncementPoliteness;
    priority?: AnnouncementPriority;
    dedupeKey?: string;
    delayMs?: number;
    ttlMs?: number;
}

export interface LiveRegionCoordinatorOptions {
    document?: Document;
    politeRegion?: HTMLElement | null;
    assertiveRegion?: HTMLElement | null;
    maxQueue?: number;
    defaultDelayMs?: number;
    dedupeWindowMs?: number;
    now?: () => number;
}

export interface LiveRegionSnapshot {
    queued: number;
    delivered: number;
    dropped: number;
    deduped: number;
    lastMessage: string | null;
}

interface QueueItem {
    id: number;
    message: string;
    politeness: AnnouncementPoliteness;
    priority: AnnouncementPriority;
    dedupeKey: string;
    readyAt: number;
    expiresAt: number;
}

const PRIORITY: Record<AnnouncementPriority, number> = { low: 0, normal: 1, high: 2 };

export class LiveRegionCoordinator {
    private readonly document: Document;
    private readonly polite: HTMLElement;
    private readonly assertive: HTMLElement;
    private readonly maxQueue: number;
    private readonly defaultDelayMs: number;
    private readonly dedupeWindowMs: number;
    private readonly now: () => number;
    private readonly queue: QueueItem[] = [];
    private readonly recent = new Map<string, number>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sequence = 0;
    private delivered = 0;
    private dropped = 0;
    private deduped = 0;
    private lastMessage: string | null = null;
    private destroyed = false;
    private ownsPolite = false;
    private ownsAssertive = false;

    constructor(options: LiveRegionCoordinatorOptions = {}) {
        this.document = options.document ?? document;
        this.maxQueue = Math.max(1, Math.floor(options.maxQueue ?? 24));
        this.defaultDelayMs = Math.max(0, options.defaultDelayMs ?? 40);
        this.dedupeWindowMs = Math.max(0, options.dedupeWindowMs ?? 1200);
        this.now = options.now ?? Date.now;
        this.polite = options.politeRegion ?? this.createRegion("polite");
        this.assertive = options.assertiveRegion ?? this.createRegion("assertive");
        this.ownsPolite = !options.politeRegion;
        this.ownsAssertive = !options.assertiveRegion;
        this.prepareRegion(this.polite, "polite");
        this.prepareRegion(this.assertive, "assertive");
    }

    announce(request: AnnouncementRequest | string): boolean {
        this.assertActive();
        const normalized = typeof request === "string" ? { message: request } : request;
        const message = normalized.message.trim().replace(/\s+/g, " ");
        if (!message) return false;
        const now = this.now();
        this.pruneRecent(now);
        const dedupeKey = (normalized.dedupeKey ?? message).trim().toLocaleLowerCase("tr-TR");
        const recentAt = this.recent.get(dedupeKey);
        if (recentAt !== undefined && now - recentAt <= this.dedupeWindowMs) {
            this.deduped += 1;
            return false;
        }
        if (this.queue.some((item) => item.dedupeKey === dedupeKey)) {
            this.deduped += 1;
            return false;
        }
        const item: QueueItem = {
            id: ++this.sequence,
            message,
            politeness: normalized.politeness ?? "polite",
            priority: normalized.priority ?? "normal",
            dedupeKey,
            readyAt: now + Math.max(0, normalized.delayMs ?? this.defaultDelayMs),
            expiresAt: now + Math.max(100, normalized.ttlMs ?? 10_000)
        };
        this.queue.push(item);
        this.queue.sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority] || a.readyAt - b.readyAt || a.id - b.id);
        while (this.queue.length > this.maxQueue) {
            this.queue.pop();
            this.dropped += 1;
        }
        this.schedule();
        return true;
    }

    clear(options: { regions?: boolean; dedupeHistory?: boolean } = {}): void {
        this.queue.splice(0);
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        if (options.regions !== false) {
            this.polite.textContent = "";
            this.assertive.textContent = "";
        }
        if (options.dedupeHistory !== false) this.recent.clear();
    }

    snapshot(): LiveRegionSnapshot {
        return Object.freeze({
            queued: this.queue.length,
            delivered: this.delivered,
            dropped: this.dropped,
            deduped: this.deduped,
            lastMessage: this.lastMessage
        });
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.clear();
        if (this.ownsPolite) this.polite.remove();
        if (this.ownsAssertive) this.assertive.remove();
    }

    private createRegion(politeness: AnnouncementPoliteness): HTMLElement {
        const region = this.document.createElement("div");
        region.dataset.experienceLiveRegion = politeness;
        this.document.body.append(region);
        return region;
    }

    private prepareRegion(region: HTMLElement, politeness: AnnouncementPoliteness): void {
        region.setAttribute("aria-live", politeness);
        region.setAttribute("aria-atomic", "true");
        region.setAttribute("role", politeness === "assertive" ? "alert" : "status");
        if (!region.hasAttribute("data-experience-live-region")) region.dataset.experienceLiveRegion = politeness;
    }

    private schedule(): void {
        if (this.timer || !this.queue.length || this.destroyed) return;
        const now = this.now();
        const nextReady = Math.min(...this.queue.map((item) => item.readyAt));
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, Math.max(0, nextReady - now));
    }

    private flush(): void {
        if (this.destroyed) return;
        const now = this.now();
        const expired = this.queue.filter((item) => item.expiresAt < now);
        if (expired.length) {
            this.dropped += expired.length;
            const expiredIds = new Set(expired.map((item) => item.id));
            for (let index = this.queue.length - 1; index >= 0; index -= 1) {
                const item = this.queue[index];
                if (item && expiredIds.has(item.id)) this.queue.splice(index, 1);
            }
        }
        const ready = this.queue.filter((item) => item.readyAt <= now);
        if (!ready.length) { this.schedule(); return; }
        const selected = ready.sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority] || a.id - b.id)[0];
        if (!selected) { this.schedule(); return; }
        const index = this.queue.findIndex((item) => item.id === selected.id);
        if (index >= 0) this.queue.splice(index, 1);
        const region = selected.politeness === "assertive" ? this.assertive : this.polite;
        region.textContent = "";
        region.textContent = selected.message;
        this.recent.set(selected.dedupeKey, now);
        this.delivered += 1;
        this.lastMessage = selected.message;
        this.schedule();
    }

    private pruneRecent(now: number): void {
        for (const [key, timestamp] of this.recent) {
            if (now - timestamp > this.dedupeWindowMs) this.recent.delete(key);
        }
    }

    private assertActive(): void {
        if (this.destroyed) throw new Error("LiveRegionCoordinator destroy edildikten sonra kullanılamaz.");
    }
}

export const createLiveRegionCoordinator = (options: LiveRegionCoordinatorOptions = {}): LiveRegionCoordinator =>
    new LiveRegionCoordinator(options);
