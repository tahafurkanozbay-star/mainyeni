import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_STATE_POLICY,
  deserializeViewState,
  normalizeViewState,
  serializeViewState,
  transitionViewState,
  viewStatesEquivalent,
  type ViewState2D,
  type ViewState3D,
} from "./viewStateContract";

const state2d: ViewState2D = {
  mode: "2d",
  center: { x: 3_650_000, y: 4_850_000, spatialReference: { wkid: 102100 } },
  scale: 25_000,
  rotation: 370,
};

const state3d: ViewState3D = {
  mode: "3d",
  center: { x: 3_650_000, y: 4_850_000, z: 125, spatialReference: { latestWkid: 3857 } },
  scale: 25_000,
  heading: -10,
  tilt: 45,
};

describe("viewStateContract", () => {
  it("normalizes Web Mercator aliases and angles deterministically", () => {
    expect(normalizeViewState(state2d)).toEqual({
      mode: "2d",
      center: { x: 3_650_000, y: 4_850_000, spatialReference: { wkid: 3857 } },
      scale: 25_000,
      rotation: 10,
    });
  });

  it("clamps scale and tilt to explicit policy budgets", () => {
    const normalized = normalizeViewState({ ...state3d, scale: 1, tilt: 100 });
    expect(normalized).toMatchObject({ mode: "3d", scale: 50, heading: 350, tilt: 85 });
  });

  it("fails closed on non-finite and implausible coordinates", () => {
    expect(normalizeViewState({ ...state2d, center: { ...state2d.center, x: Number.NaN } })).toBeNull();
    expect(normalizeViewState({ ...state2d, center: { ...state2d.center, x: 99_000_000 } })).toBeNull();
    expect(normalizeViewState({ ...state3d, center: { ...state3d.center, z: 200_000 } })).toBeNull();
  });

  it("preserves center and scale across 2D to 3D transitions", () => {
    const transition = transitionViewState(state2d, "3d");
    expect(transition).toEqual({
      from: "2d",
      to: "3d",
      changed: true,
      state: {
        mode: "3d",
        center: { x: 3_650_000, y: 4_850_000, spatialReference: { wkid: 3857 } },
        scale: 25_000,
        heading: 10,
        tilt: 0,
      },
    });
  });

  it("maps 3D heading back to 2D rotation", () => {
    const transition = transitionViewState(state3d, "2d");
    expect(transition?.state).toMatchObject({ mode: "2d", scale: 25_000, rotation: 350 });
  });

  it("does not invent a transition when the mode already matches", () => {
    const transition = transitionViewState(state2d, "2d");
    expect(transition?.changed).toBe(false);
    expect(transition?.state).toEqual(normalizeViewState(state2d));
  });

  it("round trips canonical 2D state", () => {
    const serialized = serializeViewState(state2d);
    expect(serialized).toEqual({
      v: 1,
      mode: "2d",
      x: 3_650_000,
      y: 4_850_000,
      wkid: 3857,
      scale: 25_000,
      heading: 10,
      tilt: 0,
    });
    expect(deserializeViewState(serialized)).toEqual(normalizeViewState(state2d));
  });

  it("round trips canonical 3D state including elevation", () => {
    const serialized = serializeViewState(state3d);
    expect(deserializeViewState(serialized)).toEqual(normalizeViewState(state3d));
  });

  it("rejects malformed serialized payloads", () => {
    expect(deserializeViewState(null)).toBeNull();
    expect(deserializeViewState({ v: 2, mode: "2d" })).toBeNull();
    expect(deserializeViewState({ v: 1, mode: "map", x: 0, y: 0 })).toBeNull();
    expect(deserializeViewState({ v: 1, mode: "2d", x: 0, y: 0, wkid: 3857, scale: 100, heading: 0 })).not.toBeNull();
    expect(deserializeViewState({ v: 1, mode: "3d", x: 0, y: 0, wkid: 3857, scale: 100, heading: 0 })).toBeNull();
  });

  it("compares canonical states with an explicit tolerance", () => {
    const close = { ...state2d, center: { ...state2d.center, x: state2d.center.x + 1e-8 } };
    const far = { ...state2d, center: { ...state2d.center, x: state2d.center.x + 1 } };
    expect(viewStatesEquivalent(state2d, close)).toBe(true);
    expect(viewStatesEquivalent(state2d, far)).toBe(false);
  });

  it("rejects invalid tolerance instead of silently widening equality", () => {
    expect(() => viewStatesEquivalent(state2d, state2d, -1)).toThrow("Invalid view-state tolerance");
  });

  it("rejects invalid policy configuration", () => {
    expect(() => normalizeViewState(state2d, { ...DEFAULT_VIEW_STATE_POLICY, minScale: 0 })).toThrow(
      "Invalid GIS view-state policy",
    );
    expect(() => normalizeViewState(state2d, { ...DEFAULT_VIEW_STATE_POLICY, maxTilt: 95 })).toThrow(
      "Invalid GIS view-state policy",
    );
  });
});
