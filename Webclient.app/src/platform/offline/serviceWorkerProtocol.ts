import {
  OFFLINE_PROTOCOL_VERSION,
  type OfflineWorkerRequest,
  type OfflineWorkerResponse,
  type OfflineWorkerStatus,
} from './contracts';

const REQUEST_TYPES = new Set(['status', 'clear-cache', 'skip-waiting', 'ping']);
const CACHE_TARGETS = new Set(['static', 'api', 'all']);

const nonEmptyId = (value: unknown): string | null => {
  const id = String(value ?? '').trim();
  if (!id || id.length > 120) return null;
  return /^[a-zA-Z0-9._:-]+$/u.test(id) ? id : null;
};

export const isOfflineWorkerRequest = (value: unknown): value is OfflineWorkerRequest => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.protocolVersion !== OFFLINE_PROTOCOL_VERSION) return false;
  if (!nonEmptyId(candidate.id)) return false;
  if (!REQUEST_TYPES.has(String(candidate.type))) return false;
  if (candidate.type === 'clear-cache' && candidate.cache !== undefined) {
    if (!CACHE_TARGETS.has(String(candidate.cache))) return false;
  }
  return true;
};

export const parseOfflineWorkerRequest = (value: unknown): OfflineWorkerRequest | null =>
  isOfflineWorkerRequest(value) ? Object.freeze({ ...(value as OfflineWorkerRequest) }) : null;

export const createOfflineWorkerRequest = (
  id: string,
  type: OfflineWorkerRequest['type'],
  options: { readonly cache?: 'static' | 'api' | 'all' } = {},
): OfflineWorkerRequest => {
  const normalizedId = nonEmptyId(id);
  if (!normalizedId) throw new TypeError('Offline worker message id is invalid.');
  if (!REQUEST_TYPES.has(type)) throw new TypeError('Offline worker message type is invalid.');
  if (type === 'clear-cache') {
    const cache = options.cache ?? 'all';
    if (!CACHE_TARGETS.has(cache)) throw new TypeError('Offline worker cache target is invalid.');
    return Object.freeze({
      protocolVersion: OFFLINE_PROTOCOL_VERSION,
      id: normalizedId,
      type,
      cache,
    });
  }
  return Object.freeze({
    protocolVersion: OFFLINE_PROTOCOL_VERSION,
    id: normalizedId,
    type,
  } as OfflineWorkerRequest);
};

const safeCode = (value: unknown): string => {
  const text = String(value ?? 'OFFLINE_WORKER_ERROR').trim().toUpperCase();
  return (text.replace(/[^A-Z0-9_:-]+/gu, '_') || 'OFFLINE_WORKER_ERROR').slice(0, 80);
};

const safeMessage = (value: unknown): string =>
  (String(value ?? 'Offline worker operation failed.')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim() || 'Offline worker operation failed.')
    .slice(0, 240);

export const offlineWorkerError = (
  id: string,
  code: unknown,
  message: unknown,
): OfflineWorkerResponse => Object.freeze({
  protocolVersion: OFFLINE_PROTOCOL_VERSION,
  id: nonEmptyId(id) ?? 'unknown',
  ok: false,
  type: 'error',
  code: safeCode(code),
  message: safeMessage(message),
});

export const offlineWorkerStatusResponse = (
  id: string,
  status: OfflineWorkerStatus,
): OfflineWorkerResponse => Object.freeze({
  protocolVersion: OFFLINE_PROTOCOL_VERSION,
  id: nonEmptyId(id) ?? 'unknown',
  ok: true,
  type: 'status',
  status,
});

export const offlineWorkerClearResponse = (
  id: string,
  deleted: number,
): OfflineWorkerResponse => Object.freeze({
  protocolVersion: OFFLINE_PROTOCOL_VERSION,
  id: nonEmptyId(id) ?? 'unknown',
  ok: true,
  type: 'clear-cache',
  deleted: Math.max(0, Math.trunc(Number(deleted) || 0)),
});

export const offlineWorkerSkipWaitingResponse = (
  id: string,
): OfflineWorkerResponse => Object.freeze({
  protocolVersion: OFFLINE_PROTOCOL_VERSION,
  id: nonEmptyId(id) ?? 'unknown',
  ok: true,
  type: 'skip-waiting',
});

export const offlineWorkerPongResponse = (
  id: string,
  timestamp = Date.now(),
): OfflineWorkerResponse => Object.freeze({
  protocolVersion: OFFLINE_PROTOCOL_VERSION,
  id: nonEmptyId(id) ?? 'unknown',
  ok: true,
  type: 'pong',
  timestamp: Math.max(0, Math.trunc(Number(timestamp) || 0)),
});

export const isOfflineWorkerResponse = (value: unknown): value is OfflineWorkerResponse => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.protocolVersion !== OFFLINE_PROTOCOL_VERSION) return false;
  if (!nonEmptyId(candidate.id)) return false;
  if (typeof candidate.ok !== 'boolean') return false;
  if (candidate.ok === false) {
    return candidate.type === 'error'
      && typeof candidate.code === 'string'
      && typeof candidate.message === 'string';
  }
  if (candidate.type === 'status') return Boolean(candidate.status && typeof candidate.status === 'object');
  if (candidate.type === 'clear-cache') return Number.isFinite(Number(candidate.deleted));
  if (candidate.type === 'skip-waiting') return true;
  if (candidate.type === 'pong') return Number.isFinite(Number(candidate.timestamp));
  return false;
};
