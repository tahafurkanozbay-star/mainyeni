export type SpatialQueryMode = "identify" | "selection" | "viewport" | "analysis" | "export";

export interface SpatialQueryCapabilities {
    readonly maxRecordCount?: number | null;
    readonly supportsPagination?: boolean | null;
    readonly supportsOrderBy?: boolean | null;
    readonly supportsStatistics?: boolean | null;
    readonly supportsDistinct?: boolean | null;
    readonly supportsReturningGeometryCentroid?: boolean | null;
    readonly supportsQuantization?: boolean | null;
    readonly supportsResultTypeTile?: boolean | null;
}

export interface SpatialQueryBudgetPolicy {
    readonly mode: SpatialQueryMode;
    readonly requestedFeatures?: number;
    readonly requestedPageSize?: number;
    readonly maxPages?: number;
    readonly maxFeatures?: number;
    readonly maxEstimatedBytes?: number;
    readonly averageFeatureBytes?: number;
    readonly includeGeometry?: boolean;
    readonly geometryPrecision?: number | null;
    readonly requireStableOrder?: boolean;
    readonly objectIdField?: string | null;
}

export interface SpatialQueryPagePlan {
    readonly pageIndex: number;
    readonly resultOffset: number;
    readonly resultRecordCount: number;
    readonly estimatedBytes: number;
}

export interface SpatialQueryPlan {
    readonly mode: SpatialQueryMode;
    readonly requestedFeatures: number;
    readonly admittedFeatures: number;
    readonly pageSize: number;
    readonly pageCount: number;
    readonly estimatedBytes: number;
    readonly includeGeometry: boolean;
    readonly geometryPrecision: number | null;
    readonly stableOrderField: string | null;
    readonly pagination: "offset" | "single-page";
    readonly truncatedBy: readonly SpatialQueryLimitReason[];
    readonly pages: readonly SpatialQueryPagePlan[];
}

export type SpatialQueryLimitReason =
    | "feature-budget"
    | "byte-budget"
    | "page-budget"
    | "service-record-limit"
    | "pagination-unsupported";

export interface SpatialQueryPageResult<T> {
    readonly features: readonly T[];
    readonly exceededTransferLimit?: boolean | null;
}

export interface SpatialQueryExecutionResult<T> {
    readonly features: readonly T[];
    readonly pagesRead: number;
    readonly estimatedBytes: number;
    readonly completed: boolean;
    readonly stoppedBy: SpatialQueryLimitReason | "service-complete" | "cancelled";
}

export interface SpatialQueryExecutor<T> {
    (page: SpatialQueryPagePlan, signal: AbortSignal): Promise<SpatialQueryPageResult<T>>;
}

const MODE_DEFAULTS: Readonly<Record<SpatialQueryMode, Readonly<{
    maxFeatures: number;
    maxPages: number;
    maxEstimatedBytes: number;
    averageFeatureBytes: number;
    pageSize: number;
}>>> = Object.freeze({
    identify: Object.freeze({ maxFeatures: 50, maxPages: 1, maxEstimatedBytes: 512_000, averageFeatureBytes: 2_048, pageSize: 50 }),
    selection: Object.freeze({ maxFeatures: 2_000, maxPages: 8, maxEstimatedBytes: 8_000_000, averageFeatureBytes: 2_048, pageSize: 500 }),
    viewport: Object.freeze({ maxFeatures: 5_000, maxPages: 10, maxEstimatedBytes: 16_000_000, averageFeatureBytes: 2_048, pageSize: 1_000 }),
    analysis: Object.freeze({ maxFeatures: 10_000, maxPages: 20, maxEstimatedBytes: 32_000_000, averageFeatureBytes: 3_072, pageSize: 1_000 }),
    export: Object.freeze({ maxFeatures: 25_000, maxPages: 50, maxEstimatedBytes: 64_000_000, averageFeatureBytes: 2_560, pageSize: 2_000 })
});

const MAX_SAFE_BUDGET = 1_000_000;
const MAX_SAFE_BYTES = 256_000_000;
const MAX_FIELD_LENGTH = 128;

const finitePositiveInteger = (value: number | undefined, fallback: number, ceiling: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Spatial query budgets must be finite positive numbers");
    return Math.min(Math.floor(value), ceiling);
};

const normalizeOptionalPrecision = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < 0 || value > 12) {
        throw new RangeError("geometryPrecision must be an integer between 0 and 12");
    }
    return value;
};

const normalizeField = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > MAX_FIELD_LENGTH) throw new RangeError("objectIdField is too long");
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(normalized)) {
        throw new TypeError("objectIdField contains unsupported characters");
    }
    return normalized;
};

const serviceRecordLimit = (capabilities: SpatialQueryCapabilities): number => {
    const value = capabilities.maxRecordCount;
    if (value === null || value === undefined) return 2_000;
    if (!Number.isFinite(value) || value <= 0) return 2_000;
    return Math.min(Math.floor(value), 100_000);
};

const appendReason = (reasons: SpatialQueryLimitReason[], reason: SpatialQueryLimitReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
};

export const planSpatialQuery = (
    capabilities: SpatialQueryCapabilities,
    policy: SpatialQueryBudgetPolicy
): SpatialQueryPlan => {
    const defaults = MODE_DEFAULTS[policy.mode];
    const requestedFeatures = finitePositiveInteger(policy.requestedFeatures, defaults.maxFeatures, MAX_SAFE_BUDGET);
    const maxFeatures = finitePositiveInteger(policy.maxFeatures, defaults.maxFeatures, MAX_SAFE_BUDGET);
    const maxPages = finitePositiveInteger(policy.maxPages, defaults.maxPages, 10_000);
    const maxEstimatedBytes = finitePositiveInteger(policy.maxEstimatedBytes, defaults.maxEstimatedBytes, MAX_SAFE_BYTES);
    const averageFeatureBytes = finitePositiveInteger(policy.averageFeatureBytes, defaults.averageFeatureBytes, 1_000_000);
    const recordLimit = serviceRecordLimit(capabilities);
    const requestedPageSize = finitePositiveInteger(policy.requestedPageSize, defaults.pageSize, 100_000);
    const pageSize = Math.min(requestedPageSize, recordLimit, maxFeatures);
    const reasons: SpatialQueryLimitReason[] = [];

    let admittedFeatures = Math.min(requestedFeatures, maxFeatures);
    if (admittedFeatures < requestedFeatures) appendReason(reasons, "feature-budget");

    const byteFeatureLimit = Math.max(1, Math.floor(maxEstimatedBytes / averageFeatureBytes));
    if (admittedFeatures > byteFeatureLimit) {
        admittedFeatures = byteFeatureLimit;
        appendReason(reasons, "byte-budget");
    }

    if (requestedPageSize > recordLimit) appendReason(reasons, "service-record-limit");

    const supportsPagination = capabilities.supportsPagination === true;
    if (!supportsPagination && admittedFeatures > pageSize) {
        admittedFeatures = pageSize;
        appendReason(reasons, "pagination-unsupported");
    }

    const pageFeatureLimit = pageSize * maxPages;
    if (admittedFeatures > pageFeatureLimit) {
        admittedFeatures = pageFeatureLimit;
        appendReason(reasons, "page-budget");
    }

    const requireStableOrder = policy.requireStableOrder ?? supportsPagination;
    const objectIdField = normalizeField(policy.objectIdField);
    if (requireStableOrder && supportsPagination && capabilities.supportsOrderBy !== true) {
        throw new Error("Stable paginated queries require verified orderBy support");
    }
    if (requireStableOrder && supportsPagination && objectIdField === null) {
        throw new Error("Stable paginated queries require a verified objectIdField");
    }

    const pages: SpatialQueryPagePlan[] = [];
    let offset = 0;
    while (offset < admittedFeatures) {
        const count = Math.min(pageSize, admittedFeatures - offset);
        pages.push(Object.freeze({
            pageIndex: pages.length,
            resultOffset: offset,
            resultRecordCount: count,
            estimatedBytes: count * averageFeatureBytes
        }));
        offset += count;
    }

    return Object.freeze({
        mode: policy.mode,
        requestedFeatures,
        admittedFeatures,
        pageSize,
        pageCount: pages.length,
        estimatedBytes: admittedFeatures * averageFeatureBytes,
        includeGeometry: policy.includeGeometry !== false,
        geometryPrecision: normalizeOptionalPrecision(policy.geometryPrecision),
        stableOrderField: requireStableOrder && supportsPagination ? objectIdField : null,
        pagination: supportsPagination && pages.length > 1 ? "offset" : "single-page",
        truncatedBy: Object.freeze(reasons),
        pages: Object.freeze(pages)
    });
};

const abortError = (): Error => {
    const error = new Error("Spatial query execution was cancelled");
    error.name = "AbortError";
    return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
};

export const executeSpatialQueryPlan = async <T>(
    plan: SpatialQueryPlan,
    executor: SpatialQueryExecutor<T>,
    signal: AbortSignal
): Promise<SpatialQueryExecutionResult<T>> => {
    throwIfAborted(signal);
    const features: T[] = [];
    let estimatedBytes = 0;
    let pagesRead = 0;

    for (const page of plan.pages) {
        throwIfAborted(signal);
        const result = await executor(page, signal);
        throwIfAborted(signal);
        if (!Array.isArray(result.features)) throw new TypeError("Spatial query executor returned an invalid feature collection");
        if (result.features.length > page.resultRecordCount) {
            throw new RangeError("Spatial query executor exceeded the admitted page budget");
        }
        features.push(...result.features);
        pagesRead += 1;
        estimatedBytes += result.features.length * Math.max(1, Math.floor(page.estimatedBytes / page.resultRecordCount));

        if (features.length > plan.admittedFeatures) {
            throw new RangeError("Spatial query executor exceeded the admitted feature budget");
        }

        const shortPage = result.features.length < page.resultRecordCount;
        const serviceComplete = result.exceededTransferLimit === false || (result.exceededTransferLimit !== true && shortPage);
        if (serviceComplete) {
            return Object.freeze({
                features: Object.freeze(features),
                pagesRead,
                estimatedBytes,
                completed: true,
                stoppedBy: "service-complete"
            });
        }

        if (result.features.length === 0 && result.exceededTransferLimit === true) {
            throw new Error("Spatial query pagination made no progress while transfer limit remained exceeded");
        }
    }

    const completed = features.length < plan.admittedFeatures;
    const stoppedBy: SpatialQueryExecutionResult<T>["stoppedBy"] = completed
        ? "service-complete"
        : plan.truncatedBy[0] ?? "service-complete";
    return Object.freeze({
        features: Object.freeze(features),
        pagesRead,
        estimatedBytes,
        completed,
        stoppedBy
    });
};

export interface SpatialQueryAdmissionSnapshot {
    readonly active: number;
    readonly queued: number;
    readonly completed: number;
    readonly rejected: number;
    readonly cancelled: number;
}

export interface SpatialQueryAdmissionController {
    readonly snapshot: () => SpatialQueryAdmissionSnapshot;
    readonly run: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
    readonly dispose: (reason?: unknown) => void;
}

interface QueueEntry<T> {
    readonly operation: (signal: AbortSignal) => Promise<T>;
    readonly externalSignal?: AbortSignal;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: unknown) => void;
}

export const createSpatialQueryAdmissionController = (
    maxConcurrent = 4,
    maxQueued = 32
): SpatialQueryAdmissionController => {
    const concurrency = finitePositiveInteger(maxConcurrent, 4, 64);
    const queueLimit = finitePositiveInteger(maxQueued, 32, 10_000);
    const queue: QueueEntry<unknown>[] = [];
    const activeControllers = new Set<AbortController>();
    let active = 0;
    let completed = 0;
    let rejected = 0;
    let cancelled = 0;
    let disposed = false;

    const snapshot = (): SpatialQueryAdmissionSnapshot => Object.freeze({
        active,
        queued: queue.length,
        completed,
        rejected,
        cancelled
    });

    const pump = (): void => {
        while (!disposed && active < concurrency && queue.length > 0) {
            const entry = queue.shift();
            if (!entry) break;
            if (entry.externalSignal?.aborted) {
                cancelled += 1;
                entry.reject(entry.externalSignal.reason ?? abortError());
                continue;
            }

            active += 1;
            const controller = new AbortController();
            activeControllers.add(controller);
            const onAbort = (): void => controller.abort(entry.externalSignal?.reason);
            entry.externalSignal?.addEventListener("abort", onAbort, { once: true });

            void entry.operation(controller.signal).then(
                (value) => {
                    completed += 1;
                    entry.resolve(value);
                },
                (error: unknown) => {
                    if (controller.signal.aborted) cancelled += 1;
                    else rejected += 1;
                    entry.reject(error);
                }
            ).finally(() => {
                entry.externalSignal?.removeEventListener("abort", onAbort);
                activeControllers.delete(controller);
                active -= 1;
                pump();
            });
        }
    };

    const run = <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
        if (disposed) return Promise.reject(new Error("Spatial query admission controller is disposed"));
        if (signal?.aborted) {
            cancelled += 1;
            return Promise.reject(signal.reason ?? abortError());
        }
        if (queue.length >= queueLimit) {
            rejected += 1;
            return Promise.reject(new RangeError("Spatial query queue budget exceeded"));
        }
        return new Promise<T>((resolve, reject) => {
            const entry: QueueEntry<T> = signal === undefined
                ? { operation, resolve, reject }
                : { operation, externalSignal: signal, resolve, reject };
            queue.push(entry as QueueEntry<unknown>);
            pump();
        });
    };

    const dispose = (reason: unknown = new Error("Spatial query admission controller disposed")): void => {
        if (disposed) return;
        disposed = true;
        for (const controller of activeControllers) controller.abort(reason);
        while (queue.length > 0) {
            const entry = queue.shift();
            if (!entry) continue;
            cancelled += 1;
            entry.reject(reason);
        }
    };

    return Object.freeze({ snapshot, run, dispose });
};
