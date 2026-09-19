import {
  createOfflineWorkerRequest,
  isOfflineWorkerRequest,
  isOfflineWorkerResponse,
  offlineWorkerClearResponse,
  offlineWorkerError,
  offlineWorkerPongResponse,
  offlineWorkerSkipWaitingResponse,
  offlineWorkerStatusResponse,
  parseOfflineWorkerRequest,
} from './serviceWorkerProtocol';
import type { OfflineWorkerStatus } from './contracts';

const status: OfflineWorkerStatus = Object.freeze({
  protocolVersion: 1,
  cacheVersion: 'v1',
  scope: 'https://example.test/',
  online: true,
  cacheNames: Object.freeze(['kent-v1-static']),
  staticEntries: 3,
  apiEntries: 1,
  controlledClients: 2,
  waiting: false,
});

describe('offline service worker protocol', () => {
  test.each(['status', 'skip-waiting', 'ping'] as const)(
    'creates valid %s request',
    (type) => {
      const value = createOfflineWorkerRequest('message-1', type);
      expect(isOfflineWorkerRequest(value)).toBe(true);
      expect(value.protocolVersion).toBe(1);
      expect(value.id).toBe('message-1');
    },
  );

  test('creates bounded clear-cache request', () => {
    expect(createOfflineWorkerRequest('clear-1', 'clear-cache')).toEqual({
      protocolVersion: 1,
      id: 'clear-1',
      type: 'clear-cache',
      cache: 'all',
    });
    expect(createOfflineWorkerRequest('clear-2', 'clear-cache', { cache: 'api' })).toEqual({
      protocolVersion: 1,
      id: 'clear-2',
      type: 'clear-cache',
      cache: 'api',
    });
  });

  test.each([
    '',
    'contains space',
    'x'.repeat(121),
    '../escape',
  ])('rejects invalid message id: %s', (id) => {
    expect(() => createOfflineWorkerRequest(id, 'ping')).toThrow(TypeError);
  });

  test('rejects unsupported request protocol version', () => {
    expect(isOfflineWorkerRequest({
      protocolVersion: 2,
      id: 'a',
      type: 'ping',
    })).toBe(false);
  });

  test('rejects unsupported request type', () => {
    expect(isOfflineWorkerRequest({
      protocolVersion: 1,
      id: 'a',
      type: 'execute',
    })).toBe(false);
  });

  test('rejects invalid cache target', () => {
    expect(isOfflineWorkerRequest({
      protocolVersion: 1,
      id: 'a',
      type: 'clear-cache',
      cache: 'private',
    })).toBe(false);
  });

  test('parses and freezes valid request', () => {
    const input = {
      protocolVersion: 1,
      id: 'a',
      type: 'status',
    } as const;
    const parsed = parseOfflineWorkerRequest(input);
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test('returns null for invalid input', () => {
    expect(parseOfflineWorkerRequest(null)).toBeNull();
    expect(parseOfflineWorkerRequest({ type: 'status' })).toBeNull();
  });

  test('creates valid status response', () => {
    const response = offlineWorkerStatusResponse('status-1', status);
    expect(isOfflineWorkerResponse(response)).toBe(true);
    expect(response).toMatchObject({
      id: 'status-1',
      ok: true,
      type: 'status',
    });
  });

  test('creates normalized clear response', () => {
    const response = offlineWorkerClearResponse('clear-1', -50);
    expect(response).toEqual({
      protocolVersion: 1,
      id: 'clear-1',
      ok: true,
      type: 'clear-cache',
      deleted: 0,
    });
    expect(isOfflineWorkerResponse(response)).toBe(true);
  });

  test('creates skip-waiting acknowledgement', () => {
    const response = offlineWorkerSkipWaitingResponse('skip-1');
    expect(response.type).toBe('skip-waiting');
    expect(isOfflineWorkerResponse(response)).toBe(true);
  });

  test('creates pong with non-negative timestamp', () => {
    const response = offlineWorkerPongResponse('ping-1', -1);
    expect(response.type).toBe('pong');
    if (response.ok && response.type === 'pong') {
      expect(response.timestamp).toBe(0);
    }
  });

  test('sanitizes worker error code and message', () => {
    const response = offlineWorkerError(
      'bad id',
      'cache write failed!',
      'line 1\nline 2\tsecret-ish details that are still bounded',
    );
    expect(response.id).toBe('unknown');
    if (!response.ok) {
      expect(response.code).toBe('CACHE_WRITE_FAILED_');
      expect(response.message).not.toContain('\n');
      expect(response.message.length).toBeLessThanOrEqual(240);
    }
    expect(isOfflineWorkerResponse(response)).toBe(true);
  });

  test.each([
    null,
    {},
    { protocolVersion: 2, id: 'a', ok: true, type: 'pong', timestamp: 1 },
    { protocolVersion: 1, id: '', ok: true, type: 'pong', timestamp: 1 },
    { protocolVersion: 1, id: 'a', ok: true, type: 'pong', timestamp: 'nope' },
    { protocolVersion: 1, id: 'a', ok: false, type: 'error', code: 3, message: 'bad' },
  ])('rejects malformed response %#', (value) => {
    expect(isOfflineWorkerResponse(value)).toBe(false);
  });
});
