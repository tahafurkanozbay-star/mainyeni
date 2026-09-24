import { describe, expect, it } from 'vitest';

import {
  SceneSectionRuntime,
  type SceneSectionDefinition,
} from './sceneSectionRuntime';

const plane = (
  id: string,
  overrides: Partial<SceneSectionDefinition['planes'][number]> = {},
): SceneSectionDefinition['planes'][number] => ({
  id,
  origin: { x: 32.85, y: 39.93, z: 100 },
  normal: { x: 2, y: 0, z: 0 },
  ...overrides,
});

const section = (
  id: string,
  overrides: Partial<SceneSectionDefinition> = {},
): SceneSectionDefinition => ({
  id,
  planes: [plane(`${id}-plane`)],
  ...overrides,
});

describe('SceneSectionRuntime', () => {
  it('normalizes clipping-plane normals and returns immutable plans', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('cut-a'));

    const plan = runtime.plan();

    expect(plan.admittedSections).toBe(1);
    expect(plan.admittedPlanes).toBe(1);
    expect(plan.activePlanes[0]?.normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.activePlanes)).toBe(true);
    expect(Object.isFrozen(plan.activePlanes[0]?.origin)).toBe(true);
  });

  it('rejects empty sections and zero-length normals', () => {
    const runtime = new SceneSectionRuntime();

    expect(() => runtime.upsert({ id: 'empty', planes: [] })).toThrow(/at least one/i);
    expect(() => runtime.upsert(section('zero', {
      planes: [plane('zero-plane', { normal: { x: 0, y: 0, z: 0 } })],
    }))).toThrow(/non-zero magnitude/i);
  });

  it('rejects out-of-range coordinates before they can reach a SceneView adapter', () => {
    const runtime = new SceneSectionRuntime({ coordinateMagnitude: 1_000 });

    expect(() => runtime.upsert(section('huge', {
      planes: [plane('huge-plane', { origin: { x: 1001, y: 0, z: 0 } })],
    }))).toThrow(/coordinate magnitude/i);
  });

  it('rejects duplicate plane ids within the same section', () => {
    const runtime = new SceneSectionRuntime();

    expect(() => runtime.upsert(section('duplicate', {
      planes: [plane('same'), plane('same')],
    }))).toThrow(/duplicate.*plane/i);
  });

  it('enforces section and plane registration budgets', () => {
    const runtime = new SceneSectionRuntime({
      maxSections: 1,
      maxPlanesPerSection: 2,
    });
    runtime.upsert(section('one'));

    expect(() => runtime.upsert(section('two'))).toThrow(/capacity/i);
    expect(() => runtime.upsert(section('one', {
      planes: [plane('a'), plane('b'), plane('c')],
    }))).toThrow(/exceeds 2 planes/i);
  });

  it('allows replacing an existing section without consuming another registry slot', () => {
    const runtime = new SceneSectionRuntime({ maxSections: 1 });
    runtime.upsert(section('one'));
    runtime.upsert(section('one', {
      priority: 99,
      planes: [plane('replacement')],
    }));

    expect(runtime.snapshot()).toMatchObject({ sections: 1, totalPlanes: 1 });
    expect(runtime.definitions()[0]?.priority).toBe(99);
  });

  it('filters targeted sections by requested layer ids while global sections remain active', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('roads-only', { layerIds: ['roads'] }));
    runtime.upsert(section('global'));

    const plan = runtime.plan({ layerIds: ['buildings'] });

    expect(plan.decisions).toEqual([
      expect.objectContaining({ sectionId: 'global', admitted: true }),
      expect.objectContaining({ sectionId: 'roads-only', admitted: false, reason: 'layer-filter' }),
    ]);
    expect(plan.activePlanes.map((entry) => entry.sectionId)).toEqual(['global']);
  });

  it('respects disabled sections and disabled individual planes', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('disabled-section', { enabled: false }));
    runtime.upsert(section('mixed', {
      planes: [
        plane('disabled-plane', { enabled: false }),
        plane('enabled-plane'),
      ],
    }));

    const plan = runtime.plan();

    expect(plan.decisions).toEqual([
      expect.objectContaining({ sectionId: 'disabled-section', admitted: false, reason: 'disabled' }),
      expect.objectContaining({ sectionId: 'mixed', admitted: true, planeCount: 1 }),
    ]);
    expect(plan.activePlanes.map((entry) => entry.planeId)).toEqual(['enabled-plane']);
  });

  it('admits higher-priority sections first under active-plane pressure', () => {
    const runtime = new SceneSectionRuntime({ maxActivePlanes: 2 });
    runtime.upsert(section('low', {
      priority: 1,
      planes: [plane('low-a'), plane('low-b')],
    }));
    runtime.upsert(section('high', {
      priority: 10,
      planes: [plane('high-a'), plane('high-b')],
    }));

    const plan = runtime.plan();

    expect(plan.activePlanes.map((entry) => entry.sectionId)).toEqual(['high', 'high']);
    expect(plan.decisions).toEqual([
      expect.objectContaining({ sectionId: 'high', admitted: true }),
      expect.objectContaining({ sectionId: 'low', admitted: false, reason: 'capacity' }),
    ]);
  });

  it('protects essential sections ahead of non-essential sections regardless of priority', () => {
    const runtime = new SceneSectionRuntime({ maxActivePlanes: 1 });
    runtime.upsert(section('normal', { priority: 100 }));
    runtime.upsert(section('essential', { priority: -100, essential: true }));

    const plan = runtime.plan();

    expect(plan.activePlanes[0]?.sectionId).toBe('essential');
    expect(plan.decisions.find((entry) => entry.sectionId === 'normal')).toMatchObject({
      admitted: false,
      reason: 'capacity',
    });
  });

  it('shrinks the active-plane budget under elevated and critical pressure', () => {
    const runtime = new SceneSectionRuntime({ maxActivePlanes: 8 });
    runtime.upsert(section('essential', {
      essential: true,
      priority: 10,
      planes: [plane('e1'), plane('e2')],
    }));
    runtime.upsert(section('secondary', {
      priority: 1,
      planes: [plane('s1'), plane('s2'), plane('s3'), plane('s4')],
    }));

    expect(runtime.plan({ pressure: 'normal' }).admittedPlanes).toBe(6);
    expect(runtime.plan({ pressure: 'elevated' }).admittedPlanes).toBe(6);

    const critical = runtime.plan({ pressure: 'critical' });
    expect(critical.admittedPlanes).toBe(2);
    expect(critical.decisions.find((entry) => entry.sectionId === 'secondary')).toMatchObject({
      admitted: false,
      reason: 'pressure',
    });
  });

  it('can toggle section activity without replacing geometry', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('toggle'));

    runtime.setEnabled('toggle', false);
    expect(runtime.plan().admittedPlanes).toBe(0);
    runtime.setEnabled('toggle', true);
    expect(runtime.plan().admittedPlanes).toBe(1);
    expect(runtime.definitions()[0]?.planes[0]?.id).toBe('toggle-plane');
  });

  it('returns deterministic definition and decision order independent of insertion order', () => {
    const first = new SceneSectionRuntime();
    const second = new SceneSectionRuntime();
    for (const id of ['c', 'a', 'b']) first.upsert(section(id, { priority: 1 }));
    for (const id of ['b', 'c', 'a']) second.upsert(section(id, { priority: 1 }));

    expect(first.definitions().map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(second.definitions().map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(first.plan().decisions.map((entry) => entry.sectionId)).toEqual(['a', 'b', 'c']);
    expect(second.plan().decisions.map((entry) => entry.sectionId)).toEqual(['a', 'b', 'c']);
  });

  it('normalizes and deduplicates target layer ids', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('targeted', {
      layerIds: [' buildings ', 'roads', 'buildings'],
    }));

    expect(runtime.definitions()[0]?.layerIds).toEqual(['buildings', 'roads']);
  });

  it('enforces target layer count limits', () => {
    const runtime = new SceneSectionRuntime({ maxTargetLayers: 2 });

    expect(() => runtime.upsert(section('too-many', {
      layerIds: ['a', 'b', 'c'],
    }))).toThrow(/layerIds exceed/i);
  });

  it('removes and clears sections deterministically', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('a'));
    runtime.upsert(section('b'));

    expect(runtime.remove('a')).toBe(true);
    expect(runtime.remove('a')).toBe(false);
    expect(runtime.clear()).toBe(1);
    expect(runtime.clear()).toBe(0);
    expect(runtime.snapshot().sections).toBe(0);
  });

  it('fails closed after disposal', () => {
    const runtime = new SceneSectionRuntime();
    runtime.upsert(section('a'));
    runtime.dispose();
    runtime.dispose();

    expect(runtime.snapshot()).toMatchObject({ disposed: true, sections: 0 });
    expect(() => runtime.plan()).toThrow(/disposed/i);
    expect(() => runtime.upsert(section('late'))).toThrow(/disposed/i);
  });
});
