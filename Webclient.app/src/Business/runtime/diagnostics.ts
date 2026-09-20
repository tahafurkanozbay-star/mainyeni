import type {
  BusinessDiagnosticEvent,
  BusinessDiagnosticHandle,
  BusinessDiagnosticRecordInput,
  BusinessDiagnostics,
  BusinessDiagnosticSnapshot,
  BusinessDiagnosticStatus,
} from './contracts';
import { DEFAULT_BUSINESS_RUNTIME_POLICY } from './policy';

const STATUS_VALUES: readonly BusinessDiagnosticStatus[] = Object.freeze([
  'planned',
  'started',
  'success',
  'failure',
  'cancelled',
  'empty',
  'rejected',
]);

const statusCounts = (
  events: readonly BusinessDiagnosticEvent[],
): Readonly<Record<BusinessDiagnosticStatus, number>> => {
  const counts: Record<BusinessDiagnosticStatus, number> = {
    planned: 0,
    started: 0,
    success: 0,
    failure: 0,
    cancelled: 0,
    empty: 0,
    rejected: 0,
  };
  for (const event of events) counts[event.status] += 1;
  return Object.freeze(counts);
};

const normalizedOperation = (value: unknown): string => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 160) : 'business.unknown';
};

const nonNegative = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, numeric);
};

export const createBusinessDiagnostics = (
  options: {
    readonly capacity?: number;
    readonly now?: () => number;
  } = {},
): BusinessDiagnostics => {
  const capacity = Math.min(
    4_096,
    Math.max(
      1,
      Math.trunc(
        Number.isFinite(options.capacity)
          ? Number(options.capacity)
          : DEFAULT_BUSINESS_RUNTIME_POLICY.maxDiagnosticEntries,
      ),
    ),
  );
  const now = options.now ?? Date.now;
  const events: BusinessDiagnosticEvent[] = [];
  let sequence = 0;

  const trim = (): void => {
    if (events.length > capacity) {
      events.splice(0, events.length - capacity);
    }
  };

  const record: BusinessDiagnostics['record'] = (
    operation,
    status,
    details = {},
  ) => {
    const completedAt = nonNegative(details.completedAt, now());
    const startedAt = Math.min(
      completedAt,
      nonNegative(details.startedAt, completedAt),
    );
    sequence += 1;
    const event: BusinessDiagnosticEvent = Object.freeze({
      sequence,
      operation: normalizedOperation(operation),
      status,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      ...(details.serviceKey
        ? { serviceKey: String(details.serviceKey).slice(0, 160) }
        : {}),
      ...(details.code ? { code: String(details.code).slice(0, 120) } : {}),
      ...(Number.isFinite(details.featureCount)
        ? { featureCount: Math.max(0, Math.trunc(Number(details.featureCount))) }
        : {}),
      ...(details.metadata ? { metadata: Object.freeze({ ...details.metadata }) } : {}),
    });
    events.push(event);
    trim();
    return event;
  };

  const begin: BusinessDiagnostics['begin'] = (operation, details = {}) => {
    const startedAt = now();
    const normalized = normalizedOperation(operation);
    record(normalized, 'started', {
      ...details,
      startedAt,
      completedAt: startedAt,
    });
    let finished = false;

    const handle: BusinessDiagnosticHandle = Object.freeze({
      operation: normalized,
      startedAt,
      finish(
        status: Exclude<BusinessDiagnosticStatus, 'planned' | 'started'>,
        finishDetails: BusinessDiagnosticRecordInput = {},
      ) {
        if (finished) {
          return record(normalized, status, {
            ...finishDetails,
            startedAt,
            code: finishDetails.code ?? 'DUPLICATE_FINISH',
          });
        }
        finished = true;
        return record(normalized, status, {
          ...finishDetails,
          startedAt,
        });
      },
    });

    return handle;
  };

  return Object.freeze({
    begin,
    record,
    snapshot(): BusinessDiagnosticSnapshot {
      const copy = Object.freeze(events.slice());
      return Object.freeze({
        capacity,
        sequence,
        events: copy,
        counts: statusCounts(copy),
      });
    },
    clear() {
      const removed = events.length;
      events.length = 0;
      return removed;
    },
  });
};

export const businessDiagnostics = createBusinessDiagnostics();

export const isBusinessDiagnosticStatus = (
  value: unknown,
): value is BusinessDiagnosticStatus =>
  typeof value === 'string'
  && STATUS_VALUES.includes(value as BusinessDiagnosticStatus);
