import { describe, expect, it, vi } from "vitest";
import {
  createRovingFocusController,
  createRovingTabIndex,
  getAvailableRovingIndices,
  getInitialRovingIndex,
  resolveRovingFocusMove,
} from "./rovingFocusRuntime";

const items = [
  { id: "home" },
  { id: "layers", disabled: true },
  { id: "search" },
  { id: "hidden", hidden: true },
  { id: "measure" },
] as const;

describe("rovingFocusRuntime", () => {
  it("excludes disabled and hidden items from keyboard order", () => {
    expect(getAvailableRovingIndices(items)).toEqual([0, 2, 4]);
  });

  it("uses the preferred index when it is available", () => {
    expect(getInitialRovingIndex(items, 2)).toBe(2);
  });

  it("selects the next available item when preferred is disabled", () => {
    expect(getInitialRovingIndex(items, 1)).toBe(2);
  });

  it("wraps to the first item when preferred is beyond the collection", () => {
    expect(getInitialRovingIndex(items, 99)).toBe(0);
  });

  it("returns -1 for a collection without available controls", () => {
    expect(getInitialRovingIndex([{ id: "x", disabled: true }])).toBe(-1);
  });

  it("moves horizontally while skipping unavailable controls", () => {
    expect(resolveRovingFocusMove(items, 0, "ArrowRight", { orientation: "horizontal" }))
      .toEqual({ index: 2, id: "search" });
  });

  it("moves vertically while skipping unavailable controls", () => {
    expect(resolveRovingFocusMove(items, 2, "ArrowDown", { orientation: "vertical" }))
      .toEqual({ index: 4, id: "measure" });
  });

  it("ignores vertical keys in horizontal toolbars", () => {
    expect(resolveRovingFocusMove(items, 0, "ArrowDown", { orientation: "horizontal" })).toBeNull();
  });

  it("ignores horizontal keys in vertical toolbars", () => {
    expect(resolveRovingFocusMove(items, 0, "ArrowRight", { orientation: "vertical" })).toBeNull();
  });

  it("supports Home and End independently of orientation", () => {
    expect(resolveRovingFocusMove(items, 2, "Home", { orientation: "vertical" }))
      .toEqual({ index: 0, id: "home" });
    expect(resolveRovingFocusMove(items, 2, "End", { orientation: "horizontal" }))
      .toEqual({ index: 4, id: "measure" });
  });

  it("loops from end to start by default", () => {
    expect(resolveRovingFocusMove(items, 4, "ArrowRight", { orientation: "horizontal" }))
      .toEqual({ index: 0, id: "home" });
  });

  it("loops from start to end when moving backwards", () => {
    expect(resolveRovingFocusMove(items, 0, "ArrowLeft", { orientation: "horizontal" }))
      .toEqual({ index: 4, id: "measure" });
  });

  it("stays at the edge when looping is disabled", () => {
    expect(resolveRovingFocusMove(items, 4, "ArrowRight", { orientation: "horizontal", loop: false }))
      .toEqual({ index: 4, id: "measure" });
  });

  it("reverses horizontal arrow meaning for RTL", () => {
    expect(resolveRovingFocusMove(items, 0, "ArrowLeft", { orientation: "horizontal", direction: "rtl" }))
      .toEqual({ index: 2, id: "search" });
    expect(resolveRovingFocusMove(items, 2, "ArrowRight", { orientation: "horizontal", direction: "rtl" }))
      .toEqual({ index: 0, id: "home" });
  });

  it("does not reinterpret vertical arrows for RTL", () => {
    expect(resolveRovingFocusMove(items, 0, "ArrowDown", { orientation: "vertical", direction: "rtl" }))
      .toEqual({ index: 2, id: "search" });
  });

  it("returns null for unrelated keyboard commands", () => {
    expect(resolveRovingFocusMove(items, 0, "Enter")).toBeNull();
    expect(resolveRovingFocusMove(items, 0, "Escape")).toBeNull();
    expect(resolveRovingFocusMove(items, 0, "Tab")).toBeNull();
  });

  it("returns null when no item can receive focus", () => {
    expect(resolveRovingFocusMove([{ id: "x", hidden: true }], 0, "Home")).toBeNull();
  });

  it("creates exactly one tabbable item", () => {
    expect(createRovingTabIndex(items, 2)).toEqual([-1, -1, 0, -1, -1]);
  });

  it("repairs an unavailable active index", () => {
    expect(createRovingTabIndex(items, 1)).toEqual([-1, -1, 0, -1, -1]);
  });

  it("creates no tabbable item for an unavailable collection", () => {
    expect(createRovingTabIndex([{ id: "x", disabled: true }], 0)).toEqual([-1]);
  });

  it("controller exposes initial active item and tab indices", () => {
    const controller = createRovingFocusController(items, { initialIndex: 2 });
    expect(controller.getActiveIndex()).toBe(2);
    expect(controller.getActiveId()).toBe("search");
    expect(controller.getTabIndices()).toEqual([-1, -1, 0, -1, -1]);
  });

  it("controller emits active changes only for actual moves", () => {
    const onActiveChange = vi.fn();
    const controller = createRovingFocusController(items, { onActiveChange, orientation: "horizontal" });
    controller.handleKey("ArrowRight");
    expect(onActiveChange).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith({ index: 2, id: "search" });
    controller.handleKey("Enter");
    expect(onActiveChange).toHaveBeenCalledTimes(1);
  });

  it("controller rejects programmatic activation of disabled items", () => {
    const controller = createRovingFocusController(items);
    expect(controller.setActiveIndex(1)).toBe(false);
    expect(controller.getActiveId()).toBe("home");
  });

  it("controller accepts programmatic activation of available items", () => {
    const onActiveChange = vi.fn();
    const controller = createRovingFocusController(items, { onActiveChange });
    expect(controller.setActiveIndex(4)).toBe(true);
    expect(controller.getActiveId()).toBe("measure");
    expect(onActiveChange).toHaveBeenCalledWith({ index: 4, id: "measure" });
  });

  it("preserves active identity when the collection is reordered", () => {
    const controller = createRovingFocusController(items, { initialIndex: 2 });
    controller.setItems([{ id: "measure" }, { id: "search" }, { id: "home" }]);
    expect(controller.getActiveIndex()).toBe(1);
    expect(controller.getActiveId()).toBe("search");
  });

  it("repairs active state when the active item disappears", () => {
    const controller = createRovingFocusController(items, { initialIndex: 2 });
    controller.setItems([{ id: "home" }, { id: "measure" }]);
    expect(controller.getActiveIndex()).toBe(0);
    expect(controller.getActiveId()).toBe("home");
  });

  it("repairs active state when the active item becomes disabled", () => {
    const controller = createRovingFocusController(items, { initialIndex: 2 });
    controller.setItems([{ id: "home" }, { id: "search", disabled: true }, { id: "measure" }]);
    expect(controller.getActiveId()).toBe("measure");
  });

  it("handles an empty collection without throwing", () => {
    const controller = createRovingFocusController([]);
    expect(controller.getActiveIndex()).toBe(-1);
    expect(controller.getActiveId()).toBeNull();
    expect(controller.getTabIndices()).toEqual([]);
    expect(controller.handleKey("ArrowRight")).toBeNull();
  });
});
