import { describe, expect, it } from 'vitest';
import { LayerVisibilityPolicy } from './layerVisibilityPolicy';

const context = { mode: '3d' as const, scale: 10_000, pressure: 'normal' as const };

describe('LayerVisibilityPolicy pressure regressions', () => {
  it('keeps essential parent and child visible during critical pressure', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'essential-group', enabled: true, modes: ['3d'], essential: true });
    policy.register({ id: 'essential-child', enabled: true, modes: ['3d'], parentId: 'essential-group', essential: true });
    expect(policy.decide('essential-child', { ...context, pressure: 'critical' })).toMatchObject({
      visible: true,
      reason: 'visible',
    });
  });

  it('fails child visibility when an otherwise valid parent is pressure-suppressed', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'optional-group', enabled: true, modes: ['3d'] });
    policy.register({ id: 'essential-child', enabled: true, modes: ['3d'], parentId: 'optional-group', essential: true });
    expect(policy.decide('essential-child', { ...context, pressure: 'critical' }).reason).toBe('parent-hidden');
  });

  it('treats zero opacity as non-renderable before pressure policy', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'transparent', enabled: true, modes: ['3d'], opacity: 0, essential: true });
    expect(policy.decide('transparent', { ...context, pressure: 'critical' })).toEqual({
      id: 'transparent',
      visible: false,
      reason: 'opacity',
      effectiveOpacity: 0,
    });
  });

  it('preserves exact scale boundaries', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'bounded', enabled: true, modes: ['3d'], minScale: 1_000, maxScale: 10_000 });
    expect(policy.decide('bounded', { ...context, scale: 1_000 }).visible).toBe(true);
    expect(policy.decide('bounded', { ...context, scale: 10_000 }).visible).toBe(true);
    expect(policy.decide('bounded', { ...context, scale: 999 }).reason).toBe('scale');
    expect(policy.decide('bounded', { ...context, scale: 10_001 }).reason).toBe('scale');
  });

  it('deduplicates repeated mode declarations without changing semantics', () => {
    const policy = new LayerVisibilityPolicy();
    policy.register({ id: 'both', enabled: true, modes: ['2d', '2d', '3d', '3d'] });
    expect(policy.decide('both', { ...context, mode: '2d' }).visible).toBe(true);
    expect(policy.decide('both', { ...context, mode: '3d' }).visible).toBe(true);
  });
});
