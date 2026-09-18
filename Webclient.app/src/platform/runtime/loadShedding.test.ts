import { describe, expect, it } from 'vitest';
import {
  createLoadSheddingPlanner,
  loadSheddingScore,
  type QueuedRuntimeWork,
} from './loadShedding';

const work = (
  id: string,
  overrides: Partial<QueuedRuntimeWork> = {},
): QueuedRuntimeWork => ({
  id,
  key: id,
  lane: 'default',
  priority: 'normal',
  cost: 1,
  enqueuedAt: 0,
  ...overrides,
});

describe('loadShedding', () => {
  it('does nothing below configured pressure levels', () => {
    const planner = createLoadSheddingPlanner();
    const queue = [
      work('a', { lane: 'background', priority: 'background', enqueuedAt: 0 }),
      work('b', { lane: 'prefetch', priority: 'background', enqueuedAt: 0 }),
    ];
    expect(planner.decide('nominal', queue, 10_000).selectedIds).toEqual([]);
    expect(planner.decide('elevated', queue, 10_000).selectedIds).toEqual([]);
  });

  it('selects background work first at high pressure', () => {
    const planner = createLoadSheddingPlanner();
    const decision = planner.decide('high', [
      work('normal', { lane: 'default', priority: 'normal' }),
      work('bg', { lane: 'background', priority: 'background' }),
      work('prefetch', { lane: 'prefetch', priority: 'background' }),
    ], 10_000);
    expect(decision.selectedIds[0]).toBe('prefetch');
    expect(decision.selectedIds).toContain('bg');
  });

  it('protects critical priority regardless of lane', () => {
    const planner = createLoadSheddingPlanner();
    const decision = planner.decide('critical', [
      work('critical-bg', { lane: 'background', priority: 'critical' }),
      work('normal-bg', { lane: 'background', priority: 'normal' }),
    ], 10_000);
    expect(decision.selectedIds).not.toContain('critical-bg');
    expect(decision.selectedIds).toContain('normal-bg');
    expect(decision.skippedProtected).toBe(1);
  });

  it('protects configured foreground lanes', () => {
    const planner = createLoadSheddingPlanner();
    const decision = planner.decide('critical', [
      work('interactive', { lane: 'interactive', priority: 'background' }),
      work('foreground', { lane: 'foreground', priority: 'background' }),
      work('maintenance', { lane: 'maintenance', priority: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).not.toContain('interactive');
    expect(decision.selectedIds).not.toContain('foreground');
    expect(decision.selectedIds).toContain('maintenance');
    expect(decision.skippedProtected).toBe(2);
  });

  it('protects explicitly protected work', () => {
    const planner = createLoadSheddingPlanner();
    const decision = planner.decide('critical', [
      work('protected', { lane: 'background', priority: 'background', protected: true }),
      work('shed', { lane: 'background', priority: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['shed']);
    expect(decision.skippedProtected).toBe(1);
  });

  it('does not shed fresh work before minimum age', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 1_000 });
    const decision = planner.decide('critical', [
      work('fresh', { lane: 'background', enqueuedAt: 9_500 }),
      work('old', { lane: 'background', enqueuedAt: 1_000 }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['old']);
    expect(decision.skippedYoung).toBe(1);
  });

  it('protects work close to its deadline', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      deadlineProtectionMs: 2_000,
    });
    const decision = planner.decide('critical', [
      work('urgent', { lane: 'background', deadlineAt: 11_000 }),
      work('later', { lane: 'background', deadlineAt: 30_000 }),
    ], 10_000);
    expect(decision.selectedIds).not.toContain('urgent');
    expect(decision.selectedIds).toContain('later');
    expect(decision.skippedDeadline).toBe(1);
  });

  it('does not protect already expired deadlines', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      deadlineProtectionMs: 5_000,
    });
    const decision = planner.decide('critical', [
      work('expired', { lane: 'background', deadlineAt: 9_000 }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['expired']);
  });

  it('enforces maximum selected item count', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 2,
      maxCostPerDecision: 100,
    });
    const decision = planner.decide('critical', [
      work('a', { lane: 'background' }),
      work('b', { lane: 'background' }),
      work('c', { lane: 'background' }),
    ], 10_000);
    expect(decision.selected).toHaveLength(2);
    expect(decision.exhaustedItemBudget).toBe(true);
  });

  it('enforces selected cost budget', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 10,
      maxCostPerDecision: 5,
    });
    const decision = planner.decide('critical', [
      work('expensive', { lane: 'background', cost: 4 }),
      work('second', { lane: 'background', cost: 4 }),
      work('small', { lane: 'background', cost: 1 }),
    ], 10_000);
    expect(decision.selectedCost).toBeLessThanOrEqual(5);
    expect(decision.exhaustedCostBudget).toBe(true);
  });

  it('prefers older work when scores otherwise tie', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 1,
      laneWeight: 0,
      priorityWeight: 0,
      costWeight: 0,
      ageWeight: 1,
    });
    const decision = planner.decide('critical', [
      work('new', { enqueuedAt: 9_000 }),
      work('old', { enqueuedAt: 1_000 }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['old']);
  });

  it('prefers higher cost work when configured cost weight dominates', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 1,
      laneWeight: 0,
      priorityWeight: 0,
      ageWeight: 0,
      costWeight: 10,
    });
    const decision = planner.decide('critical', [
      work('small', { cost: 1 }),
      work('large', { cost: 5 }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['large']);
  });

  it('breaks complete score ties by stable id', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 3,
      laneWeight: 0,
      priorityWeight: 0,
      ageWeight: 0,
      costWeight: 0,
    });
    const decision = planner.decide('critical', [
      work('c'),
      work('a'),
      work('b'),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['a', 'b', 'c']);
  });

  it('uses custom pressure levels', () => {
    const planner = createLoadSheddingPlanner({
      pressureLevels: ['elevated', 'high', 'critical'],
      minimumAgeMs: 0,
    });
    const decision = planner.decide('elevated', [
      work('bg', { lane: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['bg']);
  });

  it('uses custom protected lanes', () => {
    const planner = createLoadSheddingPlanner({
      protectedLanes: ['interactive', 'foreground', 'default'],
      minimumAgeMs: 0,
    });
    const decision = planner.decide('critical', [
      work('default', { lane: 'default' }),
      work('background', { lane: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['background']);
  });

  it('uses custom background lane scores', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 1,
      laneWeights: {
        batch: 500,
        background: 1,
      },
    });
    const decision = planner.decide('critical', [
      work('batch', { lane: 'batch' }),
      work('background', { lane: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['batch']);
  });

  it('uses custom priority weights', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxItemsPerDecision: 1,
      laneWeight: 0,
      priorityWeights: {
        critical: -100,
        high: 100,
        normal: 0,
        background: 1,
      },
    });
    const decision = planner.decide('critical', [
      work('high', { priority: 'high' }),
      work('background', { priority: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['high']);
  });

  it('returns reasons describing why a candidate was attractive', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 100,
      maxCostPerDecision: 16,
    });
    const decision = planner.decide('critical', [
      work('candidate', {
        lane: 'background',
        priority: 'background',
        cost: 4,
        enqueuedAt: 0,
      }),
    ], 10_000);
    expect(decision.selected[0]?.reasons).toEqual(
      expect.arrayContaining(['background-lane', 'background-priority', 'old', 'expensive']),
    );
  });

  it('normalizes negative age to zero and respects minimum age', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 100 });
    const decision = planner.decide('critical', [
      work('future', { lane: 'background', enqueuedAt: 20_000 }),
    ], 10_000);
    expect(decision.selectedIds).toEqual([]);
    expect(decision.skippedYoung).toBe(1);
  });

  it('normalizes invalid cost to at least one', () => {
    const planner = createLoadSheddingPlanner({
      minimumAgeMs: 0,
      maxCostPerDecision: 2,
    });
    const decision = planner.decide('critical', [
      work('nan', { lane: 'background', cost: Number.NaN }),
      work('negative', { lane: 'background', cost: -100 }),
    ], 10_000);
    expect(decision.selectedCost).toBe(2);
  });

  it('treats invalid ids and keys as protected from accidental selection', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 0 });
    const decision = planner.decide('critical', [
      work(' ', { key: ' ', lane: 'background' }),
      work('valid', { lane: 'background' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual(['valid']);
    expect(decision.skippedProtected).toBe(1);
  });

  it('does not mutate queue input', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 0 });
    const queue = [
      work('b', { lane: 'background' }),
      work('a', { lane: 'background' }),
    ];
    const before = queue.map((item) => item.id);
    planner.decide('critical', queue, 10_000);
    expect(queue.map((item) => item.id)).toEqual(before);
  });

  it('returns frozen decision surfaces', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 0 });
    const decision = planner.decide('critical', [
      work('a', { lane: 'background' }),
    ], 10_000);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.selected)).toBe(true);
    expect(Object.isFrozen(decision.selectedIds)).toBe(true);
    expect(Object.isFrozen(decision.selected[0])).toBe(true);
    expect(Object.isFrozen(decision.selected[0]?.reasons)).toBe(true);
  });

  it('builds an admission predicate from selected work keys', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 0 });
    const decision = planner.decide('critical', [
      work('a', { lane: 'background' }),
      work('b', { lane: 'interactive' }),
    ], 10_000);
    const predicate = planner.predicate(decision);
    expect(predicate({ key: 'a', lane: 'background' })).toBe(true);
    expect(predicate({ key: 'b', lane: 'interactive' })).toBe(false);
  });

  it('returns no work for an empty queue', () => {
    const decision = createLoadSheddingPlanner().decide('critical', [], 10_000);
    expect(decision.considered).toBe(0);
    expect(decision.selectedIds).toEqual([]);
    expect(decision.selectedCost).toBe(0);
  });

  it('exposes deterministic standalone scoring', () => {
    const oldBackground = loadSheddingScore(
      work('a', { lane: 'background', priority: 'background', cost: 3, enqueuedAt: 0 }),
      10_000,
    );
    const foreground = loadSheddingScore(
      work('b', { lane: 'foreground', priority: 'high', cost: 1, enqueuedAt: 9_000 }),
      10_000,
    );
    expect(oldBackground).toBeGreaterThan(foreground);
  });

  it('bounds extreme custom weights', () => {
    const score = loadSheddingScore(
      work('a', { lane: 'background', priority: 'background', cost: 10 }),
      10_000,
      {
        laneWeight: Number.POSITIVE_INFINITY,
        priorityWeight: 999_999,
        ageWeight: -999_999,
        costWeight: Number.NaN,
      },
    );
    expect(Number.isFinite(score)).toBe(true);
  });

  it('reports considered count including protected and young work', () => {
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 1000 });
    const decision = planner.decide('critical', [
      work('protected', { lane: 'interactive' }),
      work('young', { lane: 'background', enqueuedAt: 9_500 }),
      work('old', { lane: 'background', enqueuedAt: 0 }),
    ], 10_000);
    expect(decision.considered).toBe(3);
    expect(decision.selectedIds).toEqual(['old']);
  });

  it('can protect all work by policy without failing', () => {
    const planner = createLoadSheddingPlanner({
      protectedLanes: ['interactive', 'foreground', 'default', 'background', 'prefetch', 'maintenance'],
      minimumAgeMs: 0,
    });
    const decision = planner.decide('critical', [
      work('a', { lane: 'background' }),
      work('b', { lane: 'prefetch' }),
    ], 10_000);
    expect(decision.selectedIds).toEqual([]);
    expect(decision.skippedProtected).toBe(2);
  });

  it('preserves metadata references without inspecting sensitive payloads', () => {
    const metadata = Object.freeze({ opaque: 'redacted-by-caller' });
    const planner = createLoadSheddingPlanner({ minimumAgeMs: 0 });
    const decision = planner.decide('critical', [
      work('a', { lane: 'background', metadata }),
    ], 10_000);
    expect(decision.selected[0]?.work.metadata).toBe(metadata);
  });
});
