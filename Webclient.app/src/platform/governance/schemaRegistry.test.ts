import { describe, expect, test } from 'vitest';
import { createConfigSchemaRegistry } from './schemaRegistry';

const registry = () => {
  let now = 1_000;
  const instance = createConfigSchemaRegistry({ clock: { now: () => now } });
  return {
    instance,
    advance: (ms: number) => { now += ms; },
  };
};

describe('ConfigSchemaRegistry', () => {
  test('resolves a required bounded string', () => {
    const { instance } = registry();
    instance.register({
      key: 'api-path',
      kind: 'string',
      required: true,
      minLength: 1,
      maxLength: 32,
      pattern: /^\/(?!\/)/u,
    });
    const result = instance.resolve({ 'api-path': '/api' });
    expect(result.snapshot.valid).toBe(true);
    expect(result.values['api-path']).toBe('/api');
    expect(instance.get<string>('api-path')).toBe('/api');
  });

  test('uses aliases without exposing duplicate entries', () => {
    const { instance } = registry();
    instance.register({
      key: 'request-timeout',
      aliases: ['request_timeout', 'legacy-timeout'],
      kind: 'integer',
      minimum: 1_000,
      maximum: 60_000,
    });
    const result = instance.resolve({ request_timeout: '9000' });
    expect(result.values['request-timeout']).toBe(9000);
    expect(result.snapshot.entries).toHaveLength(1);
    expect(result.snapshot.entries[0]?.key).toBe('request-timeout');
  });

  test('prefers canonical key over aliases', () => {
    const { instance } = registry();
    instance.register({
      key: 'request-timeout',
      aliases: ['request_timeout'],
      kind: 'integer',
      minimum: 1_000,
      maximum: 60_000,
    });
    const result = instance.resolve({
      'request-timeout': 5_000,
      request_timeout: 20_000,
    });
    expect(result.values['request-timeout']).toBe(5_000);
  });

  test('rejects duplicate descriptor keys', () => {
    const { instance } = registry();
    instance.register({ key: 'mode', kind: 'string' });
    expect(() => instance.register({ key: 'mode', kind: 'boolean' }))
      .toThrow(/already registered/i);
  });

  test('rejects colliding aliases', () => {
    const { instance } = registry();
    instance.register({ key: 'first', aliases: ['shared-alias'], kind: 'string' });
    expect(() => instance.register({
      key: 'second',
      aliases: ['shared-alias'],
      kind: 'string',
    })).toThrow(/alias is already registered/i);
  });

  test('tracks a missing required value as invalid', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string', required: true });
    const result = instance.resolve({});
    expect(result.snapshot.valid).toBe(false);
    expect(result.snapshot.issues).toContainEqual(expect.objectContaining({
      key: 'release',
      code: 'missing-required',
    }));
  });

  test('can hard fail when invalid config is forbidden', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string', required: true });
    expect(() => instance.resolve({}, { rejectInvalid: true }))
      .toThrow(/configuration resolution failed/i);
  });

  test('clamps nothing silently for integers', () => {
    const { instance } = registry();
    instance.register({
      key: 'workers',
      kind: 'integer',
      minimum: 1,
      maximum: 16,
    });
    const result = instance.resolve({ workers: 99 });
    expect(result.values.workers).toBeUndefined();
    expect(result.snapshot.issues).toContainEqual(expect.objectContaining({
      key: 'workers',
      code: 'out-of-range',
    }));
  });

  test('rejects fractional numbers for integer descriptors', () => {
    const { instance } = registry();
    instance.register({
      key: 'workers',
      kind: 'integer',
      minimum: 1,
      maximum: 16,
    });
    const result = instance.resolve({ workers: 1.5 });
    expect(result.snapshot.issues[0]?.code).toBe('invalid-type');
  });

  test('parses common boolean forms deterministically', () => {
    const { instance } = registry();
    instance.register({ key: 'enabled', kind: 'boolean' });
    expect(instance.resolve({ enabled: 'yes' }).values.enabled).toBe(true);
    expect(instance.resolve({ enabled: 'OFF' }).values.enabled).toBe(false);
    expect(instance.resolve({ enabled: true }).values.enabled).toBe(true);
  });

  test('rejects ambiguous boolean values', () => {
    const { instance } = registry();
    instance.register({ key: 'enabled', kind: 'boolean' });
    const result = instance.resolve({ enabled: 'sometimes' });
    expect(result.snapshot.valid).toBe(false);
    expect(result.snapshot.issues[0]?.code).toBe('invalid-type');
  });

  test('accepts enum members and rejects unknown values', () => {
    const { instance } = registry();
    instance.register({
      key: 'environment',
      kind: 'enum',
      values: ['development', 'staging', 'production'],
    });
    expect(instance.resolve({ environment: 'staging' }).values.environment).toBe('staging');
    expect(instance.resolve({ environment: 'preview' }).snapshot.issues[0]?.code)
      .toBe('invalid-enum');
  });

  test('validates enum defaults during descriptor registration', () => {
    const { instance } = registry();
    expect(() => instance.register({
      key: 'environment',
      kind: 'enum',
      values: ['production'],
      defaultValue: 'staging',
    })).toThrow(/default enum value/i);
  });

  test('uses defaults when input is absent', () => {
    const { instance } = registry();
    instance.register({
      key: 'max-retries',
      kind: 'integer',
      minimum: 0,
      maximum: 4,
      defaultValue: 2,
    });
    const result = instance.resolve({});
    expect(result.values['max-retries']).toBe(2);
    expect(result.snapshot.entries[0]?.configured).toBe(false);
  });

  test('normalizes strings before validation', () => {
    const { instance } = registry();
    instance.register({
      key: 'region',
      kind: 'string',
      normalize: (value) => value.trim().toLocaleLowerCase('tr-TR'),
      pattern: /^[a-zçğıöşü-]+$/u,
    });
    expect(instance.resolve({ region: '  ANKARA ' }).values.region).toBe('ankara');
  });

  test('enforces bounded string length', () => {
    const { instance } = registry();
    instance.register({
      key: 'release',
      kind: 'string',
      minLength: 2,
      maxLength: 8,
    });
    expect(instance.resolve({ release: 'a' }).snapshot.issues[0]?.code).toBe('out-of-range');
    expect(instance.resolve({ release: '123456789' }).snapshot.issues[0]?.code).toBe('out-of-range');
  });

  test('parses JSON strings into immutable snapshot values', () => {
    const { instance } = registry();
    instance.register({
      key: 'limits',
      kind: 'json',
      maxBytes: 1024,
      validate: (value) => Boolean(value && typeof value === 'object'),
    });
    const result = instance.resolve({ limits: '{"max":12,"mode":"safe"}' });
    expect(result.values.limits).toEqual({ max: 12, mode: 'safe' });
    expect(result.snapshot.valid).toBe(true);
  });

  test('rejects invalid JSON text', () => {
    const { instance } = registry();
    instance.register({ key: 'limits', kind: 'json' });
    expect(instance.resolve({ limits: '{nope' }).snapshot.issues[0]?.code)
      .toBe('json-invalid');
  });

  test('rejects JSON larger than the configured byte budget', () => {
    const { instance } = registry();
    instance.register({ key: 'limits', kind: 'json', maxBytes: 32 });
    const result = instance.resolve({ limits: { text: 'x'.repeat(100) } });
    expect(result.snapshot.issues[0]?.code).toBe('json-too-large');
  });

  test('rejects cyclic JSON structures', () => {
    const { instance } = registry();
    instance.register({ key: 'limits', kind: 'json' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = instance.resolve({ limits: cyclic });
    expect(result.snapshot.issues[0]?.code).toBe('json-invalid');
  });

  test('honors custom JSON validators', () => {
    const { instance } = registry();
    instance.register({
      key: 'limits',
      kind: 'json',
      validate: (value) =>
        Boolean(value && typeof value === 'object' && (value as { mode?: unknown }).mode === 'safe'),
    });
    expect(instance.resolve({ limits: { mode: 'unsafe' } }).snapshot.issues[0]?.code)
      .toBe('json-invalid');
    expect(instance.resolve({ limits: { mode: 'safe' } }).snapshot.valid).toBe(true);
  });

  test('never exposes a secret config raw value in entry snapshots', () => {
    const { instance } = registry();
    instance.register({
      key: 'private-city-id',
      kind: 'string',
      secret: true,
    });
    const result = instance.resolve({ 'private-city-id': 'secret-value-42' });
    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).not.toContain('secret-value-42');
    expect(result.snapshot.entries[0]).toMatchObject({
      key: 'private-city-id',
      configured: true,
      secret: true,
    });
  });

  test('publicValues reports secret presence rather than its content', () => {
    const { instance } = registry();
    instance.register({ key: 'secret-key', kind: 'string', secret: true });
    instance.resolve({ 'secret-key': 'do-not-expose' });
    expect(instance.publicValues()).toEqual({ 'secret-key': '[configured]' });
  });

  test('secret fingerprint changes by presence, not by raw secret value', () => {
    const { instance } = registry();
    instance.register({ key: 'secret-key', kind: 'string', secret: true });
    const first = instance.resolve({ 'secret-key': 'alpha' }).snapshot.entries[0]?.fingerprint;
    const second = instance.resolve({ 'secret-key': 'beta' }).snapshot.entries[0]?.fingerprint;
    expect(first).toBe(second);
  });

  test('public fingerprints are deterministic for equal values', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    const first = instance.resolve({ release: 'r1' }).snapshot.entries[0]?.fingerprint;
    const second = instance.resolve({ release: 'r1' }).snapshot.entries[0]?.fingerprint;
    expect(second).toBe(first);
  });

  test('snapshot revision increments on every resolution', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    expect(instance.resolve({ release: 'r1' }).snapshot.revision).toBe(1);
    expect(instance.resolve({ release: 'r2' }).snapshot.revision).toBe(2);
  });

  test('snapshot timestamp uses the injected clock', () => {
    const { instance, advance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    expect(instance.resolve({ release: 'r1' }).snapshot.generatedAt).toBe(1_000);
    advance(50);
    expect(instance.resolve({ release: 'r2' }).snapshot.generatedAt).toBe(1_050);
  });

  test('strict unknown-key mode identifies unregistered source fields', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    const result = instance.resolve(
      { release: 'r1', unexpected: 'value' },
      { strictUnknownKeys: true },
    );
    expect(result.snapshot.issues).toContainEqual(expect.objectContaining({
      key: 'unexpected',
      code: 'unknown-key',
    }));
  });

  test('non-strict mode ignores unrelated environment fields', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    const result = instance.resolve({ release: 'r1', unrelated: 'ignored' });
    expect(result.snapshot.valid).toBe(true);
  });

  test('removing a descriptor removes its resolved value', () => {
    const { instance } = registry();
    const unregister = instance.register({ key: 'release', kind: 'string' });
    instance.resolve({ release: 'r1' });
    expect(instance.get('release')).toBe('r1');
    unregister();
    expect(instance.get('release')).toBeUndefined();
    expect(instance.keys()).toEqual([]);
  });

  test('descriptor lookup returns the normalized descriptor', () => {
    const { instance } = registry();
    instance.register({
      key: 'Release.Name',
      kind: 'string',
      required: true,
    });
    expect(instance.descriptor('release.name')).toMatchObject({
      key: 'release.name',
      kind: 'string',
      required: true,
    });
  });

  test('clear removes resolved values while retaining schemas', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    instance.resolve({ release: 'r1' });
    instance.clear();
    expect(instance.get('release')).toBeUndefined();
    expect(instance.has('release')).toBe(true);
    expect(instance.snapshot().revision).toBe(2);
  });

  test('enforces descriptor capacity', () => {
    const instance = createConfigSchemaRegistry({ maxDescriptors: 1 });
    instance.register({ key: 'one', kind: 'string' });
    expect(() => instance.register({ key: 'two', kind: 'string' }))
      .toThrow(/capacity/i);
  });

  test('bounds issue accumulation', () => {
    const instance = createConfigSchemaRegistry({ maxIssues: 2 });
    instance.register({ key: 'one', kind: 'string', required: true });
    instance.register({ key: 'two', kind: 'string', required: true });
    instance.register({ key: 'three', kind: 'string', required: true });
    expect(instance.resolve({}).snapshot.issues).toHaveLength(2);
  });

  test('dispose makes mutation and reads fail fast', () => {
    const { instance } = registry();
    instance.register({ key: 'release', kind: 'string' });
    instance.dispose();
    expect(() => instance.resolve({ release: 'r1' })).toThrow(/disposed/i);
    expect(() => instance.get('release')).toThrow(/disposed/i);
  });
});
