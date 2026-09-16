import {
  TELEMETRY_LEVELS,
  asFiniteNumber,
  asNonEmptyString,
  clampNumber,
  createMonotonicIdFactory,
  positiveInteger,
  type DurationSummary,
  type TelemetryEvent,
  type TelemetryLevel,
  type TelemetryPrimitive,
  type TelemetrySummary,
  type TelemetryValue,
} from './contracts';

export interface TelemetryOptions {
  readonly capacity?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly allowedAttributeKeys?: readonly string[];
  readonly blockedKeyFragments?: readonly string[];
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
}

export interface TelemetryRecordInput {
  readonly level?: TelemetryLevel;
  readonly domain: string;
  readonly name: string;
  readonly durationMs?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface RuntimeTelemetry {
  readonly record: (input: TelemetryRecordInput) => TelemetryEvent | null;
  readonly debug: (domain: string, name: string, attributes?: Readonly<Record<string, unknown>>) => TelemetryEvent | null;
  readonly info: (domain: string, name: string, attributes?: Readonly<Record<string, unknown>>) => TelemetryEvent | null;
  readonly warn: (domain: string, name: string, attributes?: Readonly<Record<string, unknown>>) => TelemetryEvent | null;
  readonly error: (domain: string, name: string, attributes?: Readonly<Record<string, unknown>>) => TelemetryEvent | null;
  readonly measure: <TValue>(domain: string, name: string, operation: () => Promise<TValue> | TValue, attributes?: Readonly<Record<string, unknown>>) => Promise<TValue>;
  readonly snapshot: () => readonly TelemetryEvent[];
  readonly summary: () => TelemetrySummary;
  readonly clear: () => void;
}

const DEFAULT_BLOCKED_KEY_FRAGMENTS = Object.freeze([
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'session',
  'email',
  'phone',
  'mobile',
  'name',
  'surname',
  'address',
  'coordinates',
  'latitude',
  'longitude',
  'query',
  'searchterm',
  'identity',
  'nationalid',
  'tckn',
  'user',
]);

const DEFAULT_ALLOWED_KEYS = Object.freeze([
  'attempt',
  'cache',
  'code',
  'count',
  'domain',
  'durationbucket',
  'featurecount',
  'kind',
  'level',
  'mode',
  'networktype',
  'operation',
  'phase',
  'priority',
  'reason',
  'result',
  'retryable',
  'servicecount',
  'stage',
  'status',
  'tier',
  'timeout',
  'viewmode',
]);

const normalizeKey = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();

const isBlockedKey = (key: string, blockedFragments: readonly string[]): boolean => {
  const normalized = normalizeKey(key);
  return blockedFragments.some((fragment) => normalized.includes(normalizeKey(fragment)));
};

const isAllowedKey = (key: string, allowed: ReadonlySet<string>): boolean =>
  allowed.has(normalizeKey(key));

const safeString = (value: string, maxLength: number): string => {
  const normalized = value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return normalized.slice(0, maxLength);
};

const safePrimitive = (value: unknown, maxStringLength: number): TelemetryPrimitive | undefined => {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return safeString(value, maxStringLength);
  return undefined;
};

const sanitizeValue = (
  value: unknown,
  maxStringLength: number,
  maxArrayLength: number,
): TelemetryValue | undefined => {
  const primitive = safePrimitive(value, maxStringLength);
  if (primitive !== undefined) return primitive;
  if (!Array.isArray(value)) return undefined;
  const values: TelemetryPrimitive[] = [];
  for (const item of value.slice(0, maxArrayLength)) {
    const next = safePrimitive(item, maxStringLength);
    if (next !== undefined) values.push(next);
  }
  return Object.freeze(values);
};

export const sanitizeTelemetryAttributes = (
  attributes: Readonly<Record<string, unknown>> | undefined,
  options: Pick<TelemetryOptions, 'allowedAttributeKeys' | 'blockedKeyFragments' | 'maxStringLength' | 'maxArrayLength'> = {},
): Readonly<Record<string, TelemetryValue>> | undefined => {
  if (!attributes) return undefined;
  const allowed = new Set((options.allowedAttributeKeys ?? DEFAULT_ALLOWED_KEYS).map(normalizeKey));
  const blocked = options.blockedKeyFragments ?? DEFAULT_BLOCKED_KEY_FRAGMENTS;
  const maxStringLength = positiveInteger(options.maxStringLength, 120, 500);
  const maxArrayLength = positiveInteger(options.maxArrayLength, 12, 100);
  const output: Record<string, TelemetryValue> = {};

  for (const [rawKey, value] of Object.entries(attributes)) {
    const key = asNonEmptyString(rawKey, 80);
    if (!key || isBlockedKey(key, blocked) || !isAllowedKey(key, allowed)) continue;
    const safe = sanitizeValue(value, maxStringLength, maxArrayLength);
    if (safe !== undefined) output[key] = safe;
  }

  return Object.keys(output).length > 0 ? Object.freeze(output) : undefined;
};

const normalizedLevel = (level: TelemetryLevel | undefined): TelemetryLevel =>
  level && TELEMETRY_LEVELS.includes(level) ? level : 'info';

const percentile = (sorted: readonly number[], ratio: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
};

const summarizeDurations = (durations: readonly number[]): DurationSummary => {
  if (durations.length === 0) {
    return Object.freeze({ count: 0, minMs: 0, maxMs: 0, averageMs: 0, p50Ms: 0, p95Ms: 0 });
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    averageMs: Math.round((total / sorted.length) * 100) / 100,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  });
};

export const createRuntimeTelemetry = (options: TelemetryOptions = {}): RuntimeTelemetry => {
  const capacity = positiveInteger(options.capacity, 600, 10000);
  const now = options.now ?? Date.now;
  const makeId = options.idFactory ?? createMonotonicIdFactory('evt', now);
  const events: TelemetryEvent[] = [];
  let droppedEvents = 0;

  const record = (input: TelemetryRecordInput): TelemetryEvent | null => {
    const domain = asNonEmptyString(input.domain, 64);
    const name = asNonEmptyString(input.name, 96);
    if (!domain || !name) return null;
    const duration = asFiniteNumber(input.durationMs);
    const event: TelemetryEvent = Object.freeze({
      id: makeId(),
      timestamp: now(),
      level: normalizedLevel(input.level),
      domain: safeString(domain, 64),
      name: safeString(name, 96),
      ...(duration !== null ? { durationMs: Math.max(0, Math.round(duration * 100) / 100) } : {}),
      ...(input.attributes
        ? { attributes: sanitizeTelemetryAttributes(input.attributes, options) }
        : {}),
    });

    if (events.length >= capacity) {
      events.shift();
      droppedEvents += 1;
    }
    events.push(event);
    return event;
  };

  const shorthand = (level: TelemetryLevel) =>
    (domain: string, name: string, attributes?: Readonly<Record<string, unknown>>) =>
      record({ level, domain, name, attributes });

  const measure = async <TValue>(
    domain: string,
    name: string,
    operation: () => Promise<TValue> | TValue,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<TValue> => {
    const startedAt = now();
    try {
      const value = await operation();
      record({
        level: 'info',
        domain,
        name,
        durationMs: Math.max(0, now() - startedAt),
        attributes: { ...attributes, result: 'success' },
      });
      return value;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'error')
        : 'error';
      record({
        level: 'error',
        domain,
        name,
        durationMs: Math.max(0, now() - startedAt),
        attributes: { ...attributes, result: 'failure', code },
      });
      throw error;
    }
  };

  const snapshot = (): readonly TelemetryEvent[] => Object.freeze([...events]);

  const summary = (): TelemetrySummary => {
    const countsByLevel: Record<TelemetryLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    const countsByDomain: Record<string, number> = {};
    const countsByName: Record<string, number> = {};
    const durationsByName = new Map<string, number[]>();

    for (const event of events) {
      countsByLevel[event.level] += 1;
      countsByDomain[event.domain] = (countsByDomain[event.domain] ?? 0) + 1;
      const eventKey = `${event.domain}.${event.name}`;
      countsByName[eventKey] = (countsByName[eventKey] ?? 0) + 1;
      if (event.durationMs !== undefined) {
        const values = durationsByName.get(eventKey) ?? [];
        values.push(event.durationMs);
        durationsByName.set(eventKey, values);
      }
    }

    const durations: Record<string, DurationSummary> = {};
    for (const [key, values] of durationsByName) durations[key] = summarizeDurations(values);

    return Object.freeze({
      generatedAt: now(),
      totalEvents: events.length,
      droppedEvents,
      countsByLevel: Object.freeze(countsByLevel),
      countsByDomain: Object.freeze(countsByDomain),
      countsByName: Object.freeze(countsByName),
      durations: Object.freeze(durations),
    });
  };

  const clear = (): void => {
    events.splice(0);
    droppedEvents = 0;
  };

  return Object.freeze({
    record,
    debug: shorthand('debug'),
    info: shorthand('info'),
    warn: shorthand('warn'),
    error: shorthand('error'),
    measure,
    snapshot,
    summary,
    clear,
  });
};

export const telemetryHealthScore = (summary: TelemetrySummary): number => {
  if (summary.totalEvents === 0) return 100;
  const errorRatio = summary.countsByLevel.error / summary.totalEvents;
  const warnRatio = summary.countsByLevel.warn / summary.totalEvents;
  const dropRatio = summary.droppedEvents / Math.max(1, summary.totalEvents + summary.droppedEvents);
  return Math.round(clampNumber(100 - (errorRatio * 70 + warnRatio * 20 + dropRatio * 10) * 100, 0, 100, 100));
};
