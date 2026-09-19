import { describe, expect, it } from 'vitest';
import {
  AdaptiveClusterRuntime,
  createAdaptiveClusterRuntime,
  deriveClusterRuntimePressure,
  type AdaptiveClusterFeature,
} from './adaptiveClusterRuntime';

const features = (count: number): AdaptiveClusterFeature[] => Array.from({ length: count }, (_, index) => ({
  id: index + 1,
  x: (index % 20) * 10,
  y: Math.floor(index / 20) * 10,
  label: `Feature ${index + 1}`,
  weight: 1,
  importance: index % 13 === 0 ? 10 : 0,
}));

const viewport = { width: 1200, height: 800, zoom: 12 };

describe('adaptiveClusterRuntime', () => {
  it('derives deterministic pressure from frame, memory and heap samples', () => {
    expect(deriveClusterRuntimePressure({ frameMs: 16, deviceMemoryGb: 8, heapPressure: 0.2 })).toBe('normal');
    expect(deriveClusterRuntimePressure({ frameMs: 28, deviceMemoryGb: 8, heapPressure: 0.2 })).toBe('elevated');
    expect(deriveClusterRuntimePressure({ frameMs: 16, deviceMemoryGb: 2, heapPressure: 0.2 })).toBe('elevated');
    expect(deriveClusterRuntimePressure({ frameMs: 50, deviceMemoryGb: 8, heapPressure: 0.2 })).toBe('critical');
    expect(deriveClusterRuntimePressure({ frameMs: 16, deviceMemoryGb: 8, heapPressure: 0.95 })).toBe('critical');
  });

  it('keeps sparse high-detail inputs as individual features', () => {
    const runtime = createAdaptiveClusterRuntime();
    const result = runtime.evaluate({
      features: features(20),
      viewport: { ...viewport, zoom: 19 },
      performance: { frameMs: 16, deviceMemoryGb: 8 },
    });

    expect(result.decision.mode).toBe('off');
    expect(result.featureCount).toBe(20);
    expect(result.clusterCount).toBe(0);
    expect(result.items.every((item) => item.kind === 'feature')).toBe(true);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('clusters dense input and carries bounded ids for each cluster', () => {
    const runtime = createAdaptiveClusterRuntime({ maxIdsPerCluster: 5 });
    const result = runtime.evaluate({
      features: features(20_000),
      viewport,
      performance: { frameMs: 18, deviceMemoryGb: 8 },
    });

    expect(['soft', 'aggressive']).toContain(result.decision.mode);
    expect(result.clusterCount).toBeGreaterThan(0);
    expect(result.items.every((item) => item.ids.length <= 5)).toBe(true);
    expect(result.labelCount).toBeLessThanOrEqual(result.decision.labelBudget);
  });

  it('raises clustering pressure immediately but relaxes with hysteresis', () => {
    const runtime = createAdaptiveClusterRuntime({ hysteresisFrames: 3 });
    const input = { features: features(100), viewport };

    const stressed = runtime.evaluate({
      ...input,
      performance: { frameMs: 60, deviceMemoryGb: 1 },
    });
    expect(stressed.decision.mode).toBe('aggressive');

    const recoveryOne = runtime.evaluate({
      ...input,
      performance: { frameMs: 14, deviceMemoryGb: 8 },
    });
    const recoveryTwo = runtime.evaluate({
      ...input,
      performance: { frameMs: 14, deviceMemoryGb: 8 },
    });
    const recoveryThree = runtime.evaluate({
      ...input,
      performance: { frameMs: 14, deviceMemoryGb: 8 },
    });

    expect(recoveryOne.decision.mode).toBe('aggressive');
    expect(recoveryTwo.decision.mode).toBe('aggressive');
    expect(['off', 'soft']).toContain(recoveryThree.decision.mode);
  });

  it('preserves selected features when input budget requires deterministic thinning', () => {
    const runtime = createAdaptiveClusterRuntime({
      maxInputFeatures: 1_000,
      maxSelectedFeatures: 10,
    });
    const input = features(2_000);
    input[1_999] = { ...input[1_999]!, selected: true };

    const result = runtime.evaluate({
      features: input,
      viewport: { ...viewport, zoom: 20 },
      selectedIds: [1_999],
      performance: { frameMs: 16, deviceMemoryGb: 8 },
    });

    expect(result.acceptedCount).toBe(1_000);
    expect(result.droppedCount).toBe(1_000);
    expect(result.selectedIds).toContain(2_000);
    expect(result.selectedIds).toContain(1_999);
    expect(result.items.some((item) => item.selected)).toBe(true);
  });

  it('never exceeds the accepted feature budget even when selected identities exceed it', () => {
    const runtime = createAdaptiveClusterRuntime({
      maxInputFeatures: 1_000,
      maxSelectedFeatures: 10_000,
    });
    const input = features(2_000).map((feature) => ({ ...feature, selected: true }));

    const result = runtime.evaluate({
      features: input,
      viewport: { ...viewport, zoom: 20 },
      performance: { frameMs: 16, deviceMemoryGb: 8 },
    });

    expect(result.acceptedCount).toBe(1_000);
    expect(result.items.length).toBeLessThanOrEqual(1_000);
    expect(result.selectedIds.length).toBeLessThanOrEqual(1_000);
  });

  it('drops malformed coordinates before rendering instead of producing invalid buckets', () => {
    const runtime = createAdaptiveClusterRuntime();
    const result = runtime.evaluate({
      features: [
        { id: 1, x: 10, y: 20 },
        { id: 2, x: Number.NaN, y: 20 },
        { id: 3, x: 30, y: Number.POSITIVE_INFINITY },
      ],
      viewport,
    });

    expect(result.acceptedCount).toBe(1);
    expect(result.items.flatMap((item) => item.ids)).toContain(1);
    expect(result.items.flatMap((item) => item.ids)).not.toContain(2);
    expect(result.items.flatMap((item) => item.ids)).not.toContain(3);
    expect(runtime.snapshot().droppedFeatures).toBe(2);
  });

  it('respects label budgets while selected feature labels remain visible', () => {
    const runtime = createAdaptiveClusterRuntime();
    const input = features(500);
    const result = runtime.evaluate({
      features: input,
      viewport: { ...viewport, zoom: 19 },
      selectedIds: [1],
      performance: { frameMs: 16, deviceMemoryGb: 8 },
    });

    expect(result.labelCount).toBeLessThanOrEqual(result.decision.labelBudget + 1);
    const selectedItem = result.items.find((item) => item.ids.includes(1));
    expect(selectedItem?.selected).toBe(true);
  });

  it('produces stable fingerprints for identical inputs', () => {
    const runtime = createAdaptiveClusterRuntime();
    const input = {
      features: features(250),
      viewport,
      performance: { frameMs: 18, deviceMemoryGb: 4 },
    };

    const first = runtime.evaluate(input);
    const second = runtime.evaluate(input);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.items).toEqual(second.items);
    expect(second.transitionReason).toBe('stable');
  });

  it('changes the render fingerprint when stable identities move on screen', () => {
    const runtime = createAdaptiveClusterRuntime();
    const first = runtime.evaluate({
      features: [{ id: 1, x: 10, y: 20, weight: 1 }],
      viewport: { ...viewport, zoom: 20 },
    });
    const second = runtime.evaluate({
      features: [{ id: 1, x: 40, y: 50, weight: 1 }],
      viewport: { ...viewport, zoom: 20 },
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('distinguishes numeric and string selection identities in transition fingerprints', () => {
    const runtime = createAdaptiveClusterRuntime();
    const input = [
      { id: 1, x: 10, y: 20 },
      { id: '1', x: 30, y: 40 },
    ];

    runtime.evaluate({ features: input, viewport, selectedIds: [1] });
    const changed = runtime.evaluate({ features: input, viewport, selectedIds: ['1'] });

    expect(changed.transitionReason).toBe('selection');
  });

  it('reports viewport, feature-count and selection transition causes', () => {
    const runtime = createAdaptiveClusterRuntime();
    runtime.evaluate({ features: features(100), viewport });

    const moved = runtime.evaluate({ features: features(100), viewport: { ...viewport, zoom: 14 } });
    expect(moved.transitionReason).toBe('viewport');

    const expanded = runtime.evaluate({ features: features(500), viewport: { ...viewport, zoom: 14 } });
    expect(expanded.transitionReason).toBe('feature-count');

    const selected = runtime.evaluate({
      features: features(500),
      viewport: { ...viewport, zoom: 14 },
      selectedIds: [8],
    });
    expect(selected.transitionReason).toBe('selection');
  });

  it('supports bounded reconfiguration and reset', () => {
    const runtime = new AdaptiveClusterRuntime({ maxInputFeatures: 2_000 });
    runtime.evaluate({ features: features(100), viewport });
    expect(runtime.snapshot().revision).toBe(1);

    runtime.configure({ maxInputFeatures: 1_000, hysteresisFrames: 2 });
    runtime.reset();

    expect(runtime.snapshot()).toMatchObject({
      revision: 0,
      lastMode: null,
      transitions: 0,
      droppedFeatures: 0,
    });
  });

  it('rejects use after deterministic disposal', () => {
    const runtime = createAdaptiveClusterRuntime();
    runtime.dispose();

    expect(() => runtime.evaluate({ features: [], viewport })).toThrow(/disposed/);
    expect(runtime.snapshot().disposed).toBe(true);
  });
});
