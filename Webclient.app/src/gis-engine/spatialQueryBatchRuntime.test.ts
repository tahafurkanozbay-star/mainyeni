import { describe, expect, it } from "vitest";
import type {
  SpatialQuerySession,
  SpatialQuerySessionRequest,
  SpatialQuerySessionResult,
} from "./spatialQuerySessionRuntime";
import { executeSpatialQueryBatch } from "./spatialQueryBatchRuntime";

function session(
  handler: (request: SpatialQuerySessionRequest) => Promise<SpatialQuerySessionResult>,
): SpatialQuerySession {
  return {
    capability: {} as SpatialQuerySession["capability"],
    query: handler,
    invalidate: () => 0,
    stats: () => ({
      requests: 0,
      successes: 0,
      failures: 0,
      cancellations: 0,
      invalidations: 0,
      generation: 0,
      admittedFeatures: 0,
      returnedFeatures: 0,
      pagesRead: 0,
    }),
    dispose: () => undefined,
  };
}

function fakeResult(id: string): SpatialQuerySessionResult {
  return {
    contract: { fingerprint: id } as SpatialQuerySessionResult["contract"],
    plan: {} as SpatialQuerySessionResult["plan"],
    execution: {
      features: [],
      pagesRead: 0,
      estimatedBytes: 0,
      completed: true,
      stoppedBy: "service-complete",
    },
    integrity: {
      features: [],
      issues: [],
      acceptedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      projectedCount: 0,
    },
    cacheKey: id,
    generation: 0,
  };
}

describe("spatialQueryBatchRuntime", () => {
  it("preserves input result order while honoring priority", async () => {
    const starts: string[] = [];
    const make = (id: string) =>
      session(async () => {
        starts.push(id);
        return fakeResult(id);
      });

    const result = await executeSpatialQueryBatch(
      [
        { id: "low", session: make("low"), request: { budget: { mode: "identify" } }, priority: 1 },
        { id: "high", session: make("high"), request: { budget: { mode: "identify" } }, priority: 10 },
      ],
      { maxConcurrent: 1 },
    );

    expect(starts).toEqual(["high", "low"]);
    expect(result.tasks.map((task) => task.id)).toEqual(["low", "high"]);
    expect(result.fulfilled).toBe(2);
  });

  it("rejects duplicate task ids", async () => {
    const noop = session(async () => fakeResult("x"));
    await expect(
      executeSpatialQueryBatch([
        { id: "same", session: noop, request: { budget: { mode: "identify" } } },
        { id: "same", session: noop, request: { budget: { mode: "identify" } } },
      ]),
    ).rejects.toThrow(/unique/);
  });

  it("enforces estimated memory budget before execution", async () => {
    let calls = 0;
    const counted = session(async () => {
      calls += 1;
      return fakeResult("x");
    });
    await expect(
      executeSpatialQueryBatch(
        [
          {
            id: "x",
            session: counted,
            request: { budget: { mode: "identify" } },
            estimatedBytes: 11,
          },
        ],
        { maxEstimatedBytes: 10 },
      ),
    ).rejects.toThrow(/estimated-byte budget/);
    expect(calls).toBe(0);
  });

  it("collects independent failures when configured", async () => {
    const bad = session(async () => {
      throw new Error("bad");
    });
    const good = session(async () => fakeResult("good"));

    const result = await executeSpatialQueryBatch(
      [
        { id: "bad", session: bad, request: { budget: { mode: "identify" } } },
        { id: "good", session: good, request: { budget: { mode: "identify" } } },
      ],
      { failureMode: "collect-errors", maxConcurrent: 2 },
    );

    expect(result.rejected).toBe(1);
    expect(result.fulfilled).toBe(1);
  });

  it("honors external cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      executeSpatialQueryBatch([], { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});
