import { describe, expect, test } from 'vitest';
import { createRuntimeManifestRegistry } from './manifestRegistry';

describe('RuntimeManifestRegistry', () => {
  test('accepts a valid single component', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'platform-config',
      version: '1',
      domain: 'platform',
      provides: ['runtime-config'],
    });
    expect(manifest.snapshot()).toMatchObject({
      valid: true,
      startupOrder: ['platform-config'],
    });
  });

  test('orders dependencies before consumers', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'platform-network',
      version: '1',
      domain: 'platform',
      dependsOn: ['platform-config'],
      consumes: ['runtime-config'],
    });
    manifest.register({
      id: 'platform-config',
      version: '1',
      domain: 'platform',
      provides: ['runtime-config'],
    });
    expect(manifest.startupOrder()).toEqual([
      'platform-config',
      'platform-network',
    ]);
  });

  test('detects a missing component dependency', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'platform-network',
      version: '1',
      domain: 'platform',
      dependsOn: ['platform-config'],
    });
    expect(manifest.snapshot().issues).toContainEqual(expect.objectContaining({
      componentId: 'platform-network',
      code: 'missing-dependency',
    }));
    expect(manifest.startupOrder()).toEqual([]);
  });

  test('detects a missing capability provider', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'consumer',
      version: '1',
      domain: 'platform',
      consumes: ['runtime-config'],
    });
    expect(manifest.snapshot().issues).toContainEqual(expect.objectContaining({
      componentId: 'consumer',
      code: 'missing-capability',
    }));
  });

  test('accepts a capability when any registered component provides it', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'provider',
      version: '1',
      domain: 'platform',
      provides: ['runtime-config'],
    });
    manifest.register({
      id: 'consumer',
      version: '1',
      domain: 'platform',
      consumes: ['runtime-config'],
    });
    expect(manifest.snapshot().valid).toBe(true);
  });

  test('lists all capability providers deterministically', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'provider-b',
      version: '1',
      domain: 'platform',
      provides: ['cache'],
    });
    manifest.register({
      id: 'provider-a',
      version: '1',
      domain: 'platform',
      provides: ['cache'],
    });
    expect(manifest.snapshot().capabilities.cache).toEqual([
      'provider-a',
      'provider-b',
    ]);
  });

  test('detects a two-node dependency cycle', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'a',
      version: '1',
      domain: 'platform',
      dependsOn: ['b'],
    });
    manifest.register({
      id: 'b',
      version: '1',
      domain: 'platform',
      dependsOn: ['a'],
    });
    expect(manifest.snapshot().issues.some((item) => item.code === 'dependency-cycle'))
      .toBe(true);
    expect(manifest.startupOrder()).toEqual([]);
  });

  test('detects a longer dependency cycle', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'a',
      version: '1',
      domain: 'platform',
      dependsOn: ['b'],
    });
    manifest.register({
      id: 'b',
      version: '1',
      domain: 'platform',
      dependsOn: ['c'],
    });
    manifest.register({
      id: 'c',
      version: '1',
      domain: 'platform',
      dependsOn: ['a'],
    });
    expect(manifest.validate()).toContainEqual(expect.objectContaining({
      code: 'dependency-cycle',
    }));
  });

  test('rejects direct self dependency', () => {
    const manifest = createRuntimeManifestRegistry();
    expect(() => manifest.register({
      id: 'self',
      version: '1',
      domain: 'platform',
      dependsOn: ['self'],
    })).toThrow(/cannot depend on itself/i);
  });

  test('rejects duplicate component ids', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    expect(() => manifest.register({ id: 'one', version: '2', domain: 'platform' }))
      .toThrow(/already registered/i);
  });

  test('normalizes component identifiers', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'Platform.Config', version: '1', domain: 'Platform' });
    expect(manifest.component('platform.config')).toMatchObject({
      id: 'platform.config',
      domain: 'platform',
    });
  });

  test('rejects invalid identifiers', () => {
    const manifest = createRuntimeManifestRegistry();
    expect(() => manifest.register({
      id: '../bad',
      version: '1',
      domain: 'platform',
    })).toThrow(/identifier/i);
  });

  test('rejects malformed versions', () => {
    const manifest = createRuntimeManifestRegistry();
    expect(() => manifest.register({
      id: 'one',
      version: ' bad version ',
      domain: 'platform',
    })).toThrow(/version/i);
  });

  test('supports semver-like prerelease versions', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'one',
      version: '2.0.0-rc.1',
      domain: 'platform',
    });
    expect(manifest.component('one')?.version).toBe('2.0.0-rc.1');
  });

  test('eager zero-dependency components precede lazy peers', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'lazy',
      version: '1',
      domain: 'platform',
      startup: 'lazy',
    });
    manifest.register({
      id: 'eager',
      version: '1',
      domain: 'platform',
      startup: 'eager',
    });
    expect(manifest.startupOrder()).toEqual(['eager', 'lazy']);
  });

  test('dependency order wins over lazy/eager preference', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({
      id: 'lazy-provider',
      version: '1',
      domain: 'platform',
      startup: 'lazy',
    });
    manifest.register({
      id: 'eager-consumer',
      version: '1',
      domain: 'platform',
      startup: 'eager',
      dependsOn: ['lazy-provider'],
    });
    expect(manifest.startupOrder()).toEqual([
      'lazy-provider',
      'eager-consumer',
    ]);
  });

  test('replace updates a component in place', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    manifest.replace({ id: 'one', version: '2', domain: 'platform' });
    expect(manifest.component('one')?.version).toBe('2');
    expect(manifest.snapshot().components).toHaveLength(1);
  });

  test('replace can create a new component below capacity', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.replace({ id: 'one', version: '1', domain: 'platform' });
    expect(manifest.component('one')).not.toBeNull();
  });

  test('remove reports if a component existed', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    expect(manifest.remove('one')).toBe(true);
    expect(manifest.remove('one')).toBe(false);
  });

  test('unregister function removes the component', () => {
    const manifest = createRuntimeManifestRegistry();
    const unregister = manifest.register({ id: 'one', version: '1', domain: 'platform' });
    unregister();
    expect(manifest.component('one')).toBeNull();
  });

  test('snapshot fingerprint is stable until the graph changes', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    const first = manifest.snapshot().fingerprint;
    const second = manifest.snapshot().fingerprint;
    expect(second).toBe(first);
    manifest.replace({ id: 'one', version: '2', domain: 'platform' });
    expect(manifest.snapshot().fingerprint).not.toBe(first);
  });

  test('revision increments on graph mutations', () => {
    const manifest = createRuntimeManifestRegistry();
    expect(manifest.snapshot().revision).toBe(0);
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    expect(manifest.snapshot().revision).toBe(1);
    manifest.replace({ id: 'one', version: '2', domain: 'platform' });
    expect(manifest.snapshot().revision).toBe(2);
    manifest.remove('one');
    expect(manifest.snapshot().revision).toBe(3);
  });

  test('enforces component capacity', () => {
    const manifest = createRuntimeManifestRegistry({ maxComponents: 1 });
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    expect(() => manifest.register({ id: 'two', version: '1', domain: 'platform' }))
      .toThrow(/capacity/i);
  });

  test('enforces dependency capacity', () => {
    const manifest = createRuntimeManifestRegistry({ maxDependenciesPerComponent: 1 });
    expect(() => manifest.register({
      id: 'main',
      version: '1',
      domain: 'platform',
      dependsOn: ['a', 'b'],
    })).toThrow(/capacity/i);
  });

  test('enforces capability capacity', () => {
    const manifest = createRuntimeManifestRegistry({ maxCapabilitiesPerComponent: 1 });
    expect(() => manifest.register({
      id: 'main',
      version: '1',
      domain: 'platform',
      provides: ['a', 'b'],
    })).toThrow(/capacity/i);
  });

  test('clear removes the entire graph', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    manifest.clear();
    expect(manifest.snapshot().components).toEqual([]);
    expect(manifest.startupOrder()).toEqual([]);
  });

  test('dispose rejects subsequent operations', () => {
    const manifest = createRuntimeManifestRegistry();
    manifest.register({ id: 'one', version: '1', domain: 'platform' });
    manifest.dispose();
    expect(() => manifest.snapshot()).toThrow(/disposed/i);
    expect(() => manifest.register({ id: 'two', version: '1', domain: 'platform' }))
      .toThrow(/disposed/i);
  });
});
