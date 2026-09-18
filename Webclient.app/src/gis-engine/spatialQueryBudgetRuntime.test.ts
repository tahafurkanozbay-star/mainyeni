import { describe, expect, it } from "vitest";
import {
    createSpatialQueryAdmissionController,
    executeSpatialQueryPlan,
    planSpatialQuery
} from "./spatialQueryBudgetRuntime";

describe("planSpatialQuery", () => {
    it("caps requests by feature and service page budgets", () => {
        const plan = planSpatialQuery(
            { maxRecordCount: 500, supportsPagination: true, supportsOrderBy: true },
            {
                mode: "viewport",
                requestedFeatures: 9_000,
                maxFeatures: 4_000,
                requestedPageSize: 1_000,
                objectIdField: "OBJECTID"
            }
        );
        expect(plan.admittedFeatures).toBe(4_000);
        expect(plan.pageSize).toBe(500);
        expect(plan.pageCount).toBe(8);
        expect(plan.stableOrderField).toBe("OBJECTID");
        expect(plan.truncatedBy).toContain("feature-budget");
        expect(plan.truncatedBy).toContain("service-record-limit");
    });

    it("caps by estimated transfer bytes", () => {
        const plan = planSpatialQuery(
            { maxRecordCount: 2_000, supportsPagination: true, supportsOrderBy: true },
            {
                mode: "analysis",
                requestedFeatures: 10_000,
                maxEstimatedBytes: 10_000,
                averageFeatureBytes: 2_000,
                objectIdField: "OID"
            }
        );
        expect(plan.admittedFeatures).toBe(5);
        expect(plan.estimatedBytes).toBe(10_000);
        expect(plan.truncatedBy).toContain("byte-budget");
    });

    it("fails closed when stable pagination cannot be proven", () => {
        expect(() => planSpatialQuery(
            { supportsPagination: true, supportsOrderBy: false },
            { mode: "viewport", requestedFeatures: 4_000, objectIdField: "OBJECTID" }
        )).toThrow(/orderBy/);
        expect(() => planSpatialQuery(
            { supportsPagination: true, supportsOrderBy: true },
            { mode: "viewport", requestedFeatures: 4_000 }
        )).toThrow(/objectIdField/);
    });

    it("uses a single page when pagination is not verified", () => {
        const plan = planSpatialQuery(
            { maxRecordCount: 250, supportsPagination: false },
            { mode: "selection", requestedFeatures: 2_000 }
        );
        expect(plan.admittedFeatures).toBe(250);
        expect(plan.pageCount).toBe(1);
        expect(plan.pagination).toBe("single-page");
        expect(plan.truncatedBy).toContain("pagination-unsupported");
    });

    it("enforces page-count budgets", () => {
        const plan = planSpatialQuery(
            { maxRecordCount: 100, supportsPagination: true, supportsOrderBy: true },
            {
                mode: "analysis",
                requestedFeatures: 1_000,
                maxPages: 3,
                requestedPageSize: 100,
                objectIdField: "OBJECTID"
            }
        );
        expect(plan.admittedFeatures).toBe(300);
        expect(plan.pageCount).toBe(3);
        expect(plan.truncatedBy).toContain("page-budget");
    });

    it("rejects malformed budget and field inputs", () => {
        expect(() => planSpatialQuery({}, { mode: "identify", requestedFeatures: Number.POSITIVE_INFINITY })).toThrow(RangeError);
        expect(() => planSpatialQuery({}, { mode: "identify", geometryPrecision: 13 })).toThrow(RangeError);
        expect(() => planSpatialQuery(
            { supportsPagination: true, supportsOrderBy: true },
            { mode: "viewport", objectIdField: "OID;DROP TABLE" }
        )).toThrow(TypeError);
    });
});

describe("executeSpatialQueryPlan", () => {
    it("stops on a short service-complete page", async () => {
        const plan = planSpatialQuery(
            { maxRecordCount: 100, supportsPagination: true, supportsOrderBy: true },
            { mode: "selection", requestedFeatures: 300, requestedPageSize: 100, objectIdField: "OID" }
        );
        const controller = new AbortController();
        const result = await executeSpatialQueryPlan(
            plan,
            async (page) => ({
                features: page.pageIndex === 0 ? [1, 2] : [],
                exceededTransferLimit: false
            }),
            controller.signal
        );
        expect(result.features).toEqual([1, 2]);
        expect(result.pagesRead).toBe(1);
        expect(result.completed).toBe(true);
        expect(result.stoppedBy).toBe("service-complete");
    });

    it("rejects a page that exceeds its admitted feature count", async () => {
        const plan = planSpatialQuery({}, { mode: "identify", requestedFeatures: 2 });
        await expect(executeSpatialQueryPlan(
            plan,
            async () => ({ features: [1, 2, 3] }),
            new AbortController().signal
        )).rejects.toThrow(/page budget/);
    });

    it("detects non-progressing transfer-limited pagination", async () => {
        const plan = planSpatialQuery(
            { supportsPagination: true, supportsOrderBy: true },
            { mode: "selection", requestedFeatures: 100, objectIdField: "OID" }
        );
        await expect(executeSpatialQueryPlan(
            plan,
            async () => ({ features: [], exceededTransferLimit: true }),
            new AbortController().signal
        )).rejects.toThrow(/no progress/);
    });

    it("honors cancellation before transport", async () => {
        const plan = planSpatialQuery({}, { mode: "identify" });
        const controller = new AbortController();
        controller.abort(new Error("cancelled-by-test"));
        await expect(executeSpatialQueryPlan(
            plan,
            async () => ({ features: [] }),
            controller.signal
        )).rejects.toThrow("cancelled-by-test");
    });
});

describe("createSpatialQueryAdmissionController", () => {
    it("bounds concurrent query work", async () => {
        const admission = createSpatialQueryAdmissionController(1, 4);
        let active = 0;
        let peak = 0;
        const operation = async (): Promise<number> => {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            return peak;
        };
        const values = await Promise.all([
            admission.run(operation),
            admission.run(operation),
            admission.run(operation)
        ]);
        expect(values).toEqual([1, 1, 1]);
        expect(peak).toBe(1);
        expect(admission.snapshot().completed).toBe(3);
    });

    it("rejects queue overflow", async () => {
        const admission = createSpatialQueryAdmissionController(1, 1);
        let release: (() => void) | undefined;
        const blocked = admission.run(async () => new Promise<void>((resolve) => { release = resolve; }));
        const queued = admission.run(async () => "queued");
        await expect(admission.run(async () => "overflow")).rejects.toThrow(/queue budget/);
        release?.();
        await blocked;
        await expect(queued).resolves.toBe("queued");
    });

    it("cancels queued work without starting it", async () => {
        const admission = createSpatialQueryAdmissionController(1, 2);
        let release: (() => void) | undefined;
        const first = admission.run(async () => new Promise<void>((resolve) => { release = resolve; }));
        const controller = new AbortController();
        let started = false;
        const second = admission.run(async () => {
            started = true;
            return 2;
        }, controller.signal);
        controller.abort(new Error("queued-cancel"));
        release?.();
        await first;
        await expect(second).rejects.toThrow("queued-cancel");
        expect(started).toBe(false);
        expect(admission.snapshot().cancelled).toBe(1);
    });

    it("aborts active work and rejects queued work on dispose", async () => {
        const admission = createSpatialQueryAdmissionController(1, 2);
        const active = admission.run(async (signal) => new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
        const queued = admission.run(async () => 2);
        admission.dispose(new Error("shutdown"));
        await expect(active).rejects.toThrow("shutdown");
        await expect(queued).rejects.toThrow("shutdown");
    });
});
