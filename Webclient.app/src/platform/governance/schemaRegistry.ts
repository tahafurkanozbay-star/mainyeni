import {
  boundedInteger,
  boundedText,
  freezeArray,
  governanceIdentifier,
  isPlainRecord,
  stableFingerprint,
  stableStringify,
  type BooleanConfigDescriptor,
  type ConfigDescriptor,
  type ConfigEntrySnapshot,
  type ConfigIssue,
  type ConfigRegistrySnapshot,
  type EnumConfigDescriptor,
  type GovernanceClock,
  type IntegerConfigDescriptor,
  type JsonConfigDescriptor,
  type StringConfigDescriptor,
  defaultGovernanceClock,
} from './contracts';

export interface ConfigResolveOptions {
  readonly strictUnknownKeys?: boolean;
  readonly rejectInvalid?: boolean;
}

export interface ConfigRegistryOptions {
  readonly clock?: GovernanceClock;
  readonly maxDescriptors?: number;
  readonly maxIssues?: number;
}

export interface ConfigResolveResult {
  readonly values: Readonly<Record<string, unknown>>;
  readonly snapshot: ConfigRegistrySnapshot;
}

export interface ConfigSchemaRegistry {
  readonly register: (descriptor: ConfigDescriptor) => () => void;
  readonly has: (key: string) => boolean;
  readonly descriptor: (key: string) => ConfigDescriptor | null;
  readonly resolve: (source?: Readonly<Record<string, unknown>>, options?: ConfigResolveOptions) => ConfigResolveResult;
  readonly get: <T = unknown>(key: string) => T | undefined;
  readonly publicValues: () => Readonly<Record<string, unknown>>;
  readonly snapshot: () => ConfigRegistrySnapshot;
  readonly keys: () => readonly string[];
  readonly clear: () => void;
  readonly dispose: () => void;
}

interface NormalizedDescriptorBase {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly kind: ConfigDescriptor['kind'];
  readonly required: boolean;
  readonly secret: boolean;
  readonly description: string;
}

type NormalizedDescriptor =
  | (NormalizedDescriptorBase & StringConfigDescriptor)
  | (NormalizedDescriptorBase & IntegerConfigDescriptor)
  | (NormalizedDescriptorBase & BooleanConfigDescriptor)
  | (NormalizedDescriptorBase & EnumConfigDescriptor)
  | (NormalizedDescriptorBase & JsonConfigDescriptor);

const toAliases = (key: string, aliases: readonly string[] | undefined): readonly string[] => {
  const output = new Set<string>();
  for (const alias of aliases ?? []) {
    const normalized = governanceIdentifier(alias, 'config alias', 120);
    if (normalized !== key) output.add(normalized);
  }
  return freezeArray(output);
};

const normalizeDescriptor = (descriptor: ConfigDescriptor): NormalizedDescriptor => {
  if (!descriptor || typeof descriptor !== 'object') throw new TypeError('config descriptor is required');
  const key = governanceIdentifier(descriptor.key, 'config key', 120);
  const base: NormalizedDescriptorBase = {
    key,
    aliases: toAliases(key, descriptor.aliases),
    kind: descriptor.kind,
    required: descriptor.required === true,
    secret: descriptor.secret === true,
    description: boundedText(descriptor.description, '', 240),
  };

  switch (descriptor.kind) {
    case 'string': {
      const minimum = boundedInteger(descriptor.minLength, 0, 0, 16_384);
      const maximum = boundedInteger(descriptor.maxLength, 512, Math.max(1, minimum), 64 * 1024);
      return Object.freeze({ ...descriptor, ...base, minLength: minimum, maxLength: maximum });
    }
    case 'integer': {
      const minimum = Number.isFinite(descriptor.minimum) ? Number(descriptor.minimum) : Number.MIN_SAFE_INTEGER;
      const maximum = Number.isFinite(descriptor.maximum) ? Number(descriptor.maximum) : Number.MAX_SAFE_INTEGER;
      if (minimum > maximum) throw new RangeError(`config ${key} minimum exceeds maximum`);
      return Object.freeze({ ...descriptor, ...base, minimum, maximum });
    }
    case 'boolean':
      return Object.freeze({ ...descriptor, ...base });
    case 'enum': {
      const values = freezeArray(
        Array.from(new Set(descriptor.values.map((value) => boundedText(value, '', 120)).filter(Boolean))),
      );
      if (values.length === 0) throw new TypeError(`config ${key} enum values are required`);
      if (descriptor.defaultValue !== undefined && !values.includes(descriptor.defaultValue)) {
        throw new TypeError(`config ${key} default enum value is not allowed`);
      }
      return Object.freeze({ ...descriptor, ...base, values });
    }
    case 'json':
      return Object.freeze({
        ...descriptor,
        ...base,
        maxBytes: boundedInteger(descriptor.maxBytes, 64 * 1024, 32, 2 * 1024 * 1024),
      });
    default:
      throw new TypeError(`unsupported config descriptor kind: ${String((descriptor as ConfigDescriptor).kind)}`);
  }
};

const firstConfigured = (
  source: Readonly<Record<string, unknown>>,
  descriptor: NormalizedDescriptor,
): { configured: boolean; value: unknown } => {
  const candidates = [descriptor.key, ...descriptor.aliases];
  for (const key of candidates) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) continue;
    return { configured: true, value };
  }
  return { configured: false, value: undefined };
};

const issue = (key: string, code: ConfigIssue['code'], message: string): ConfigIssue =>
  Object.freeze({ key, code, message: boundedText(message, code, 240) });

const parseBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return null;
};

const parseString = (
  descriptor: NormalizedDescriptor & StringConfigDescriptor,
  value: unknown,
): { value?: string; issue?: ConfigIssue } => {
  if (typeof value !== 'string') return { issue: issue(descriptor.key, 'invalid-type', 'value must be a string') };
  const normalized = descriptor.normalize ? descriptor.normalize(value) : value.trim();
  const minimum = descriptor.minLength ?? 0;
  const maximum = descriptor.maxLength ?? 512;
  if (normalized.length < minimum || normalized.length > maximum) {
    return { issue: issue(descriptor.key, 'out-of-range', `string length must be between ${minimum} and ${maximum}`) };
  }
  if (descriptor.pattern && !descriptor.pattern.test(normalized)) {
    return { issue: issue(descriptor.key, 'invalid-pattern', 'string does not match the configured pattern') };
  }
  return { value: normalized };
};

const parseInteger = (
  descriptor: NormalizedDescriptor & IntegerConfigDescriptor,
  value: unknown,
): { value?: number; issue?: ConfigIssue } => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) return { issue: issue(descriptor.key, 'invalid-type', 'value must be a safe integer') };
  const minimum = descriptor.minimum ?? Number.MIN_SAFE_INTEGER;
  const maximum = descriptor.maximum ?? Number.MAX_SAFE_INTEGER;
  if (numeric < minimum || numeric > maximum) {
    return { issue: issue(descriptor.key, 'out-of-range', `integer must be between ${minimum} and ${maximum}`) };
  }
  return { value: numeric };
};

const parseEnum = (
  descriptor: NormalizedDescriptor & EnumConfigDescriptor,
  value: unknown,
): { value?: string; issue?: ConfigIssue } => {
  const normalized = boundedText(value, '', 120);
  if (!descriptor.values.includes(normalized)) {
    return { issue: issue(descriptor.key, 'invalid-enum', 'value is not in the configured enum') };
  }
  return { value: normalized };
};

const cloneJson = (value: unknown): unknown => {
  const serialized = stableStringify(value);
  return JSON.parse(serialized) as unknown;
};

const parseJson = (
  descriptor: NormalizedDescriptor & JsonConfigDescriptor,
  value: unknown,
): { value?: unknown; issue?: ConfigIssue } => {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return { issue: issue(descriptor.key, 'json-invalid', 'value must contain valid JSON') };
    }
  }
  try {
    const serialized = stableStringify(parsed);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > (descriptor.maxBytes ?? 64 * 1024)) {
      return { issue: issue(descriptor.key, 'json-too-large', 'JSON value exceeds the configured byte budget') };
    }
    const cloned = JSON.parse(serialized) as unknown;
    if (descriptor.validate && !descriptor.validate(cloned)) {
      return { issue: issue(descriptor.key, 'json-invalid', 'JSON value failed schema validation') };
    }
    return { value: cloned };
  } catch {
    return { issue: issue(descriptor.key, 'json-invalid', 'JSON value must be finite and acyclic') };
  }
};

const defaultFor = (descriptor: NormalizedDescriptor): unknown => {
  switch (descriptor.kind) {
    case 'string': return descriptor.defaultValue;
    case 'integer': return descriptor.defaultValue;
    case 'boolean': return descriptor.defaultValue;
    case 'enum': return descriptor.defaultValue;
    case 'json': return descriptor.defaultValue === undefined ? undefined : cloneJson(descriptor.defaultValue);
  }
};

const parseConfigured = (
  descriptor: NormalizedDescriptor,
  value: unknown,
): { value?: unknown; issue?: ConfigIssue } => {
  switch (descriptor.kind) {
    case 'string':
      return parseString(descriptor, value);
    case 'integer':
      return parseInteger(descriptor, value);
    case 'boolean': {
      const parsed = parseBoolean(value);
      return parsed === null
        ? { issue: issue(descriptor.key, 'invalid-type', 'value must be a recognized boolean') }
        : { value: parsed };
    }
    case 'enum':
      return parseEnum(descriptor, value);
    case 'json':
      return parseJson(descriptor, value);
  }
};

export const createConfigSchemaRegistry = (options: ConfigRegistryOptions = {}): ConfigSchemaRegistry => {
  const clock = options.clock ?? defaultGovernanceClock;
  const maxDescriptors = boundedInteger(options.maxDescriptors, 128, 1, 1024);
  const maxIssues = boundedInteger(options.maxIssues, 64, 1, 512);
  const descriptors = new Map<string, NormalizedDescriptor>();
  let values: Readonly<Record<string, unknown>> = Object.freeze({});
  let lastSnapshot: ConfigRegistrySnapshot = Object.freeze({
    revision: 0,
    generatedAt: clock.now(),
    valid: true,
    issues: Object.freeze([]),
    entries: Object.freeze([]),
    fingerprint: stableFingerprint({}),
  });
  let revision = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('config schema registry has been disposed');
  };

  const register = (input: ConfigDescriptor): (() => void) => {
    assertActive();
    if (descriptors.size >= maxDescriptors) throw new RangeError('config descriptor capacity exceeded');
    const descriptor = normalizeDescriptor(input);
    if (descriptors.has(descriptor.key)) throw new Error(`config descriptor already registered: ${descriptor.key}`);
    const aliases = new Set(Array.from(descriptors.values()).flatMap((item) => [item.key, ...item.aliases]));
    if (descriptor.aliases.some((alias) => aliases.has(alias))) {
      throw new Error(`config descriptor alias is already registered: ${descriptor.key}`);
    }
    descriptors.set(descriptor.key, descriptor);
    return () => {
      descriptors.delete(descriptor.key);
      if (Object.prototype.hasOwnProperty.call(values, descriptor.key)) {
        const mutable = { ...values };
        delete mutable[descriptor.key];
        values = Object.freeze(mutable);
      }
    };
  };

  const resolve = (
    source: Readonly<Record<string, unknown>> = {},
    resolveOptions: ConfigResolveOptions = {},
  ): ConfigResolveResult => {
    assertActive();
    const nextValues: Record<string, unknown> = {};
    const issues: ConfigIssue[] = [];
    const entries: ConfigEntrySnapshot[] = [];
    const knownSourceKeys = new Set<string>();

    for (const descriptor of descriptors.values()) {
      knownSourceKeys.add(descriptor.key);
      descriptor.aliases.forEach((alias) => knownSourceKeys.add(alias));
      const configured = firstConfigured(source, descriptor);
      const parsed = configured.configured ? parseConfigured(descriptor, configured.value) : { value: defaultFor(descriptor) };
      if (parsed.issue) issues.push(parsed.issue);
      if (!configured.configured && parsed.value === undefined && descriptor.required) {
        issues.push(issue(descriptor.key, 'missing-required', 'required configuration value is missing'));
      }

      if (parsed.value !== undefined && !parsed.issue) nextValues[descriptor.key] = parsed.value;
      const publicFingerprintValue = descriptor.secret
        ? { configured: configured.configured || parsed.value !== undefined }
        : parsed.value;
      entries.push(Object.freeze({
        key: descriptor.key,
        configured: configured.configured,
        secret: descriptor.secret,
        ...(descriptor.secret || parsed.value === undefined ? {} : { value: parsed.value }),
        fingerprint: stableFingerprint(publicFingerprintValue),
      }));
      if (issues.length >= maxIssues) break;
    }

    if (resolveOptions.strictUnknownKeys) {
      for (const sourceKey of Object.keys(source)) {
        if (knownSourceKeys.has(sourceKey.toLowerCase()) || knownSourceKeys.has(sourceKey)) continue;
        issues.push(issue(sourceKey.slice(0, 120), 'unknown-key', 'source contains an unregistered configuration key'));
        if (issues.length >= maxIssues) break;
      }
    }

    if (resolveOptions.rejectInvalid && issues.length > 0) {
      const summary = issues.slice(0, 5).map((item) => `${item.key}:${item.code}`).join(', ');
      throw new Error(`configuration resolution failed: ${summary}`);
    }

    revision += 1;
    values = Object.freeze(nextValues);
    const orderedEntries = freezeArray(entries.sort((left, right) => left.key.localeCompare(right.key, 'en')));
    const orderedIssues = freezeArray(issues.slice(0, maxIssues));
    const fingerprint = stableFingerprint({
      revision,
      entries: orderedEntries.map((entry) => ({
        key: entry.key,
        configured: entry.configured,
        secret: entry.secret,
        fingerprint: entry.fingerprint,
      })),
      issues: orderedIssues.map((item) => [item.key, item.code]),
    });
    lastSnapshot = Object.freeze({
      revision,
      generatedAt: clock.now(),
      valid: orderedIssues.length === 0,
      issues: orderedIssues,
      entries: orderedEntries,
      fingerprint,
    });
    return Object.freeze({ values, snapshot: lastSnapshot });
  };

  const get = <T = unknown>(key: string): T | undefined => {
    assertActive();
    const normalized = governanceIdentifier(key, 'config key', 120);
    return values[normalized] as T | undefined;
  };

  const publicValues = (): Readonly<Record<string, unknown>> => {
    assertActive();
    const output: Record<string, unknown> = {};
    for (const descriptor of descriptors.values()) {
      const value = values[descriptor.key];
      if (descriptor.secret) {
        output[descriptor.key] = value === undefined ? false : '[configured]';
      } else if (value !== undefined) {
        output[descriptor.key] = value;
      }
    }
    return Object.freeze(output);
  };

  const snapshot = (): ConfigRegistrySnapshot => lastSnapshot;
  const keys = (): readonly string[] => freezeArray([...descriptors.keys()].sort((a, b) => a.localeCompare(b, 'en')));

  const clear = (): void => {
    assertActive();
    values = Object.freeze({});
    revision += 1;
    lastSnapshot = Object.freeze({
      revision,
      generatedAt: clock.now(),
      valid: true,
      issues: Object.freeze([]),
      entries: Object.freeze([]),
      fingerprint: stableFingerprint({ revision }),
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    descriptors.clear();
    values = Object.freeze({});
  };

  return Object.freeze({
    register,
    has: (key: string) => descriptors.has(governanceIdentifier(key, 'config key', 120)),
    descriptor: (key: string) => descriptors.get(governanceIdentifier(key, 'config key', 120)) ?? null,
    resolve,
    get,
    publicValues,
    snapshot,
    keys,
    clear,
    dispose,
  });
};
