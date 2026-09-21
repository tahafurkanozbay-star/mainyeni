import { describe, expect, it } from "vitest";
import { createViewStateHistoryRuntime } from "./viewStateHistoryRuntime";
import type { ViewState2D, ViewState3D } from "./viewStateContract";

const state2d = (x = 1_000, rotation = 0): ViewState2D => ({
  mode: "2d",
  center: { x, y: 2_000, spatialReference: { wkid: 102100 } },
  scale: 25_000,
  rotation,
});

const state3d = (x = 1_000): ViewState3D => ({
  mode: "3d",
  center: { x, y: 2_000, z: 50, spatialReference: { latestWkid: 3857 } },
  scale: 25_000,
  heading: 15,
  tilt: 40,
});

describe("viewStateHistoryRuntime", () => {
  it("records canonical state and exposes navigation capabilities", () => {
    const runtime = createViewStateHistoryRuntime({ now: () => 10 });
    expect(runtime.record(state2d())?.state.wkid).toBe(3857);
    runtime.record(state2d(2_000), "pan");
    expect(runtime.snapshot()).toMatchObject({ cursor: 1, canGoBack: true, canGoForward: false, revision: 2 });
    expect(runtime.current()?.reason).toBe("pan");
  });

  it("deduplicates tolerance-equivalent states", () => {
    const runtime = createViewStateHistoryRuntime();
    const first = runtime.record(state2d());
    const duplicate = runtime.record(state2d(1_000 + 1e-8));
    expect(duplicate?.id).toBe(first?.id);
    expect(runtime.snapshot().entries).toHaveLength(1);
    expect(runtime.metrics().deduplicated).toBe(1);
  });

  it("bounds history and evicts oldest entries deterministically", () => {
    const runtime = createViewStateHistoryRuntime({
      historyPolicy: { maxEntries: 3, maxBookmarks: 2, equivalenceTolerance: 1e-7, maxBookmarkNameLength: 20 },
    });
    runtime.record(state2d(1));
    runtime.record(state2d(2));
    runtime.record(state2d(3));
    runtime.record(state2d(4));
    expect(runtime.snapshot().entries.map((entry) => entry.state.x)).toEqual([2, 3, 4]);
    expect(runtime.snapshot().cursor).toBe(2);
    expect(runtime.metrics().evicted).toBe(1);
  });

  it("supports bounded back and forward navigation", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d(1));
    runtime.record(state2d(2));
    runtime.record(state2d(3));
    expect(runtime.back()?.state.x).toBe(2);
    expect(runtime.back()?.state.x).toBe(1);
    expect(runtime.back()).toBeNull();
    expect(runtime.forward()?.state.x).toBe(2);
    expect(runtime.metrics()).toMatchObject({ backNavigations: 2, forwardNavigations: 1 });
  });

  it("drops forward history after a new navigation branch", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d(1));
    runtime.record(state2d(2));
    runtime.record(state2d(3));
    runtime.back();
    runtime.record(state2d(9), "search-result");
    expect(runtime.snapshot().entries.map((entry) => entry.state.x)).toEqual([1, 2, 9]);
    expect(runtime.snapshot().canGoForward).toBe(false);
  });

  it("jumps only to retained stable entry ids", () => {
    const runtime = createViewStateHistoryRuntime();
    const first = runtime.record(state2d(1));
    runtime.record(state2d(2));
    expect(runtime.jump(first?.id ?? -1)?.state.x).toBe(1);
    expect(runtime.jump(999_999)).toBeNull();
  });

  it("saves canonical bookmarks from explicit state or current history", () => {
    let time = 100;
    const runtime = createViewStateHistoryRuntime({ now: () => time++ });
    runtime.record(state2d());
    const current = runtime.saveBookmark("home", "  Home   View  ");
    const explicit = runtime.saveBookmark("scene:one", "Scene", state3d());
    expect(current).toMatchObject({ id: "home", name: "Home View" });
    expect(explicit?.state.mode).toBe("3d");
    expect(runtime.listBookmarks().map((bookmark) => bookmark.name)).toEqual(["Home View", "Scene"]);
  });

  it("updates bookmark without consuming another capacity slot", () => {
    const runtime = createViewStateHistoryRuntime({
      historyPolicy: { maxEntries: 4, maxBookmarks: 1, equivalenceTolerance: 1e-7, maxBookmarkNameLength: 20 },
    });
    runtime.record(state2d());
    expect(runtime.saveBookmark("home", "Home")).not.toBeNull();
    expect(runtime.saveBookmark("home", "Updated", state2d(2))).toMatchObject({ name: "Updated" });
    expect(runtime.saveBookmark("second", "Second")).toBeNull();
    expect(runtime.listBookmarks()).toHaveLength(1);
  });

  it("filters bookmarks by view mode", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.saveBookmark("map", "Map", state2d());
    runtime.saveBookmark("scene", "Scene", state3d());
    expect(runtime.listBookmarks("2d").map((bookmark) => bookmark.id)).toEqual(["map"]);
    expect(runtime.listBookmarks("3d").map((bookmark) => bookmark.id)).toEqual(["scene"]);
  });

  it("restores bookmarks through normal history semantics", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d(1));
    runtime.saveBookmark("scene", "Scene", state3d(8));
    const restored = runtime.restoreBookmark("scene");
    expect(restored?.state).toMatchObject({ mode: "3d", x: 8 });
    expect(restored?.reason).toBe("bookmark:scene");
  });

  it("rejects malformed bookmark identifiers and names", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d());
    expect(runtime.saveBookmark("", "Home")).toBeNull();
    expect(runtime.saveBookmark("bad id", "Home")).toBeNull();
    expect(runtime.saveBookmark("ok", "   ")).toBeNull();
    expect(runtime.metrics().rejected).toBe(3);
  });

  it("truncates bookmark names to configured bound", () => {
    const runtime = createViewStateHistoryRuntime({
      historyPolicy: { maxEntries: 4, maxBookmarks: 2, equivalenceTolerance: 1e-7, maxBookmarkNameLength: 5 },
    });
    runtime.record(state2d());
    expect(runtime.saveBookmark("home", "Long bookmark name")?.name).toBe("Long ");
  });

  it("deletes bookmarks without affecting navigation history", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d());
    runtime.saveBookmark("home", "Home");
    expect(runtime.deleteBookmark("home")).toBe(true);
    expect(runtime.deleteBookmark("home")).toBe(false);
    expect(runtime.snapshot().entries).toHaveLength(1);
    expect(runtime.metrics().bookmarkDeletes).toBe(1);
  });

  it("rejects invalid view states without corrupting history", () => {
    const runtime = createViewStateHistoryRuntime();
    const invalid = { ...state2d(), center: { ...state2d().center, x: Number.NaN } };
    expect(runtime.record(invalid)).toBeNull();
    expect(runtime.snapshot().entries).toHaveLength(0);
    expect(runtime.metrics().rejected).toBe(1);
  });

  it("clears navigation history but preserves bookmarks", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d());
    runtime.saveBookmark("home", "Home");
    runtime.clearHistory();
    expect(runtime.current()).toBeNull();
    expect(runtime.listBookmarks()).toHaveLength(1);
    expect(runtime.restoreBookmark("home")).not.toBeNull();
  });

  it("disposes deterministically and rejects later mutation", () => {
    const runtime = createViewStateHistoryRuntime();
    runtime.record(state2d());
    runtime.saveBookmark("home", "Home");
    runtime.dispose();
    expect(runtime.snapshot()).toMatchObject({ entries: [], cursor: -1, bookmarks: [] });
    expect(runtime.record(state2d(2))).toBeNull();
    expect(runtime.saveBookmark("late", "Late", state2d())).toBeNull();
    expect(runtime.metrics().rejected).toBe(2);
  });

  it("validates bounded policy eagerly", () => {
    expect(() => createViewStateHistoryRuntime({
      historyPolicy: { maxEntries: 1, maxBookmarks: 1, equivalenceTolerance: 0, maxBookmarkNameLength: 10 },
    })).toThrow("maxEntries");
    expect(() => createViewStateHistoryRuntime({
      historyPolicy: { maxEntries: 4, maxBookmarks: 0, equivalenceTolerance: 0, maxBookmarkNameLength: 10 },
    })).toThrow("maxBookmarks");
    expect(() => createViewStateHistoryRuntime({
      historyPolicy: { maxEntries: 4, maxBookmarks: 1, equivalenceTolerance: -1, maxBookmarkNameLength: 10 },
    })).toThrow("equivalenceTolerance");
  });
});
