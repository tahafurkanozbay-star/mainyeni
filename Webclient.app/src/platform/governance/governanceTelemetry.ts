import {
  boundedInteger,
  boundedText,
  freezeArray,
  sanitizeEvidenceDetail,
  type GovernanceClock,
} from './contracts';

export type GovernanceTelemetryLevel = 'debug' | 'info' | 'warn' | 'error';
export type GovernanceTelemetryPrimitive = string | number | boolean | null;

export interface GovernanceTelemetryEvent {
  readonly sequence: number;
  readonly timestamp: number;
  readonly level: GovernanceTelemetryLevel;
  readonly domain: string;
  readonly name: string;
  readonly attributes?: Readonly<Record<string, GovernanceTelemetryPrimitive>>;
}

export interface GovernanceTelemetrySummary {
  readonly generatedAt: number;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly countsByLevel: Readonly<Record<GovernanceTelemetryLevel, number>>;
  readonly countsByDomain: Readonly<Record<string, number>>;
}

export interface GovernanceTelemetry {
  readonly record: (
    level: GovernanceTelemetryLevel,
    domain: string,
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => GovernanceTelemetryEvent | null;
  readonly debug: (
    domain: string,
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => GovernanceTelemetryEvent | null;
  readonly info: (
    domain: string,
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => GovernanceTelemetryEvent | null;
  readonly warn: (
    domain: string,
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => GovernanceTelemetryEvent | null;
  readonly error: (
    domain: string,
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => GovernanceTelemetryEvent | null;
  readonly snapshot: () => readonly GovernanceTelemetryEvent[];
  readonly summary: () => GovernanceTelemetrySummary;
  readonly clear: () => void;
}

export interface GovernanceTelemetryOptions {
  readonly clock: GovernanceClock;
  readonly capacity?: number;
}

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  'code',
  'count',
  'mode',
  'operation',
  'phase',
  'reason',
  'result',
  'status',
]);

const BLOCKED_KEY_FRAGMENTS = Object.freeze([
  'address',
  'authorization',
  'cookie',
  'credential',
  'email',
  'identity',
  'latitude',
  'longitude',
  'password',
  'query',
  'search',
  'secret',
  'session',
  'token',
  'user',
]);

const normalizeKey = (value: string): string =>
  value.replace(/[^a-z0-9]/giu, '').toLowerCase();

const safeString = (value: string): string => {
  const normalized = sanitizeEvidenceDetail(value) ?? '';
  return boundedText(normalized, '', 120);
};

const safePrimitive = (
  value: unknown,
): GovernanceTelemetryPrimitive | undefined => {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const normalized = safeString(value);
    return normalized || undefined;
  }
  return undefined;
};

const sanitizeAttributes = (
  attributes: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, GovernanceTelemetryPrimitive>> | undefined => {
  if (!attributes) return undefined;
  const output: Record<string, GovernanceTelemetryPrimitive> = {};

  for (const [rawKey, value] of Object.entries(attributes)) {
    const key = normalizeKey(rawKey);
    if (!key || !ALLOWED_ATTRIBUTE_KEYS.has(key)) continue;
    if (BLOCKED_KEY_FRAGMENTS.some((fragment) => key.includes(fragment))) continue;
    const safe = safePrimitive(value);
    if (safe !== undefined) output[rawKey.slice(0, 80)] = safe;
  }

  return Object.keys(output).length > 0 ? Object.freeze(output) : undefined;
};

export const createGovernanceTelemetry = (
  options: GovernanceTelemetryOptions,
): GovernanceTelemetry => {
  const capacity = boundedInteger(options.capacity, 400, 1, 4_096);
  const ring = new Array<GovernanceTelemetryEvent | undefined>(capacity);
  let cursor = 0;
  let count = 0;
  let sequence = 0;
  let droppedEvents = 0;

  const record = (
    level: GovernanceTelemetryLevel,
    domainInput: string,
    nameInput: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): GovernanceTelemetryEvent | null => {
    const domain = boundedText(domainInput, '', 64);
    const name = boundedText(nameInput, '', 96);
    if (!domain || !name) return null;

    const event = Object.freeze({
      sequence: ++sequence,
      timestamp: options.clock.now(),
      level,
      domain,
      name,
      ...(sanitizeAttributes(attributes) === undefined
        ? {}
        : { attributes: sanitizeAttributes(attributes) }),
    }) as GovernanceTelemetryEvent;

    if (count === capacity) droppedEvents += 1;
    else count += 1;
    ring[cursor] = event;
    cursor = (cursor + 1) % capacity;
    return event;
  };

  const shorthand = (level: GovernanceTelemetryLevel) =>
    (
      domain: string,
      name: string,
      attributes?: Readonly<Record<string, unknown>>,
    ): GovernanceTelemetryEvent | null => record(level, domain, name, attributes);

  const snapshot = (): readonly GovernanceTelemetryEvent[] => {
    if (count === 0) return Object.freeze([]);
    const output: GovernanceTelemetryEvent[] = [];
    const oldest = (cursor - count + capacity) % capacity;
    for (let offset = 0; offset < count; offset += 1) {
      const event = ring[(oldest + offset) % capacity];
      if (event) output.push(event);
    }
    return freezeArray(output);
  };

  const summary = (): GovernanceTelemetrySummary => {
    const countsByLevel: Record<GovernanceTelemetryLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };
    const countsByDomain: Record<string, number> = {};
    for (const event of snapshot()) {
      countsByLevel[event.level] += 1;
      countsByDomain[event.domain] = (countsByDomain[event.domain] ?? 0) + 1;
    }
    return Object.freeze({
      generatedAt: options.clock.now(),
      totalEvents: count,
      droppedEvents,
      countsByLevel: Object.freeze(countsByLevel),
      countsByDomain: Object.freeze(countsByDomain),
    });
  };

  const clear = (): void => {
    for (let index = 0; index < ring.length; index += 1) {
      ring[index] = undefined;
    }
    cursor = 0;
    count = 0;
    droppedEvents = 0;
  };

  return Object.freeze({
    record,
    debug: shorthand('debug'),
    info: shorthand('info'),
    warn: shorthand('warn'),
    error: shorthand('error'),
    snapshot,
    summary,
    clear,
  });
};
