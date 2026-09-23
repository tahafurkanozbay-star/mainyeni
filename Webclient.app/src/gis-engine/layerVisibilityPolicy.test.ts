import { describe, expect, it } from 'vitest';
import { LayerVisibilityPolicy } from './layerVisibilityPolicy';

const context = { mode: '2d' as const, scale: 5_000, pressure: 'normal' as const };

describe('LayerVisibilityPolicy', () => {
  it('applies mode ArcGIS scale opacity and enabled gates', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'roads', enabled: true, modes: ['2d'], minScale: 10_000, maxScale: 1_000, opacity: 0.5 });
    expect(policy.decide('roads', context)).toMatchObject({ visible: true, effectiveOpacity: 0.5 });
    expect(policy.decide('roads', { ...context, mode: '3d' }).reason).toBe('mode');
    expect(policy.decide('roads', { ...context, scale: 20_000 }).reason).toBe('scale');
    expect(policy.decide('roads', { ...context, scale: 500 }).reason).toBe('scale');
  });

  it('propagates hidden parent state', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'group', enabled: false, modes: ['2d', '3d'] });
    policy.register({ id: 'child', enabled: true, modes: ['2d'], parentId: 'group' });
    expect(policy.decide('child', context).reason).toBe('parent-hidden');
  });

  it('protects essential layers under critical pressure', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'base', enabled: true, modes: ['2d'], essential: true });
    policy.register({ id: 'decorative', enabled: true, modes: ['2d'] });
    expect(policy.decide('base', { ...context, pressure: 'critical' }).visible).toBe(true);
    expect(policy.decide('decorative', { ...context, pressure: 'critical' }).reason).toBe('resource-pressure');
  });

  it('returns deterministic sorted decisions', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'z', enabled: true, modes: ['2d'] });
    policy.register({ id: 'a', enabled: true, modes: ['2d'] });
    expect(policy.decideAll(context).map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  it('bounds metadata and validates malformed contracts', () => {
    const policy = new LayerVisibilityPolicy(1);
    policy.register({ id: 'a', enabled: true, modes: ['2d'] });
    expect(() => policy.register({ id: 'b', enabled: true, modes: ['2d'] })).toThrow('capacity');
    expect(() => new LayerVisibilityPolicy(0)).toThrow();
    expect(() => new LayerVisibilityPolicy().register({ id: ' ', enabled: true, modes: ['2d'] })).toThrow();
    expect(() => new LayerVisibilityPolicy().register({ id: 'x', enabled: true, modes: [] })).toThrow();
    expect(() => new LayerVisibilityPolicy().register({ id: 'range', enabled: true, modes: ['2d'], minScale: 1_000, maxScale: 10_000 })).toThrow();
  });

  it('prevents orphan parents and unsafe removals', () => {
    const policy = new LayerVisibilityPolicy();
    expect(() => policy.register({ id: 'child', enabled: true, modes: ['2d'], parentId: 'missing' })).toThrow('unknown parent');
    policy.register({ id: 'group', enabled: true, modes: ['2d'] });
    policy.register({ id: 'child', enabled: true, modes: ['2d'], parentId: 'group' });
    expect(() => policy.remove('group')).toThrow('registered children');
    expect(policy.remove('child')).toBe(true);
    expect(policy.remove('group')).toBe(true);
  });
});
