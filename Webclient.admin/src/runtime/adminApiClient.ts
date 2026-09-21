import { Global } from '../Core/Global';
import {
  AdminRequestCoordinator,
  AdminRequestCoordinatorError,
  adminRequestCoordinator,
} from './adminRequestCoordinator';
import {
  clearAdminSession,
  readAdminSession,
} from './adminSession';

export type AdminApiErrorCode =
  | 'invalid-request'
  | 'unauthenticated'
  | 'forbidden'
  | 'http-error'
  | 'timeout'
  | 'aborted'
  | 'network-error'
  | 'queue-full'
  | 'queue-timeout'
  | 'response-too-large'
  | 'invalid-json'
  | 'invalid-content-type';

export class AdminApiError extends Error {
  public readonly code: AdminApiErrorCode;
  public readonly status: number | null;

  public constructor(
    code: AdminApiErrorCode,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
    this.status = status;
  }
}

export type AdminApiQueryValue = string | number | boolean | null | undefined;

export interface AdminApiRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly query?: Readonly<Record<string, AdminApiQueryValue>>;
  readonly body?: unknown;
  readonly formData?: FormData;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly authenticated?: boolean;
  readonly redirectOnUnauthorized?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly coordinator?: AdminRequestCoordinator;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_QUEUE_WAIT_MS = 5_000;

const clampInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

const normalizeEndpointPath = (value: string): string => {
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new AdminApiError(
      'invalid-request',
      'Admin API endpoint must be an absolute application path.',
    );
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new AdminApiError(
      'invalid-request',
      'Admin API endpoint contains a forbidden path segment.',
    );
  }

  return path;
};

const buildRequestUrl = (
  baseUrl: string,
  endpointPath: string,
  query: AdminApiRequestOptions['query'],
): string => {
  const base = String(baseUrl).trim().replace(/\/+$/u, '');
  const path = normalizeEndpointPath(endpointPath);
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }

  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return `${base}${path}${suffix}`;
};

const createBoundedSignal = (
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}> => {
  const controller = new AbortController();
  let timeoutTriggered = false;

  const abortFromExternal = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason);
    }
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  const timeout = globalThis.setTimeout(() => {
    timeoutTriggered = true;
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Admin API request timed out.', 'TimeoutError'));
    }
  }, timeoutMs);

  return Object.freeze({
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  });
};

const safeRedirectToLogin = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.location.assign('./');
  } catch {
    // jsdom/restricted contexts can reject navigation. Session is already cleared.
  }
};

const contentLength = (response: Response): number | null => {
  const raw = response.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseJsonResponse = async <T>(
  response: Response,
  maximumBytes: number,
): Promise<T> => {
  const advertised = contentLength(response);
  if (advertised !== null && advertised > maximumBytes) {
    throw new AdminApiError(
      'response-too-large',
      'Admin API response exceeded the permitted payload budget.',
      response.status,
    );
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    contentType
    && !contentType.includes('application/json')
    && !contentType.includes('+json')
  ) {
    throw new AdminApiError(
      'invalid-content-type',
      'Admin API returned an unexpected response type.',
      response.status,
    );
  }

  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maximumBytes) {
    throw new AdminApiError(
      'response-too-large',
      'Admin API response exceeded the permitted payload budget.',
      response.status,
    );
  }

  if (!text.trim()) return null as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AdminApiError(
      'invalid-json',
      'Admin API returned malformed JSON.',
      response.status,
    );
  }
};

const responseError = (response: Response): AdminApiError => {
  if (response.status === 401) {
    return new AdminApiError(
      'unauthenticated',
      'Admin session is no longer authorized.',
      response.status,
    );
  }
  if (response.status === 403) {
    return new AdminApiError(
      'forbidden',
      'Admin session does not have permission for this operation.',
      response.status,
    );
  }
  return new AdminApiError(
    'http-error',
    `Admin API request failed with HTTP ${response.status}.`,
    response.status,
  );
};

const coordinatorError = (
  error: AdminRequestCoordinatorError,
): AdminApiError => {
  switch (error.code) {
    case 'queue-full':
      return new AdminApiError(
        'queue-full',
        'Admin API request queue is at capacity.',
      );
    case 'queue-timeout':
      return new AdminApiError(
        'queue-timeout',
        'Admin API request waited too long for network capacity.',
      );
    case 'aborted':
      return new AdminApiError(
        'aborted',
        'Admin API request was aborted.',
      );
  }
};

const singleFlightKey = (
  method: 'GET' | 'POST',
  url: string,
  timeoutMs: number,
  maxResponseBytes: number,
  authenticated: boolean,
  externalSignal: AbortSignal | undefined,
): string | undefined => {
  if (method !== 'GET' || externalSignal !== undefined) return undefined;
  return [
    method,
    authenticated ? 'auth' : 'public',
    timeoutMs,
    maxResponseBytes,
    url,
  ].join('|');
};

export const adminApiRequest = async <T>(
  endpointPath: string,
  options: AdminApiRequestOptions = {},
): Promise<T> => {
  const authenticated = options.authenticated ?? true;
  const redirectOnUnauthorized =
    options.redirectOnUnauthorized ?? authenticated;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new AdminApiError(
      'network-error',
      'Fetch API is unavailable in this browser.',
    );
  }

  if (options.body !== undefined && options.formData !== undefined) {
    throw new AdminApiError(
      'invalid-request',
      'Admin API request cannot contain JSON body and FormData together.',
    );
  }

  const method = options.method
    ?? (options.body === undefined && options.formData === undefined ? 'GET' : 'POST');

  if (
    method === 'GET'
    && (options.body !== undefined || options.formData !== undefined)
  ) {
    throw new AdminApiError(
      'invalid-request',
      'GET requests cannot contain request bodies.',
    );
  }

  const headers = new Headers({ Accept: 'application/json' });
  if (authenticated) {
    const session = readAdminSession();
    if (!session) {
      throw new AdminApiError(
        'unauthenticated',
        'Admin session is required for this operation.',
        401,
      );
    }
    headers.set('Authorization', `Bearer ${session.accessToken}`);
  }

  let body: BodyInit | undefined;
  if (options.formData !== undefined) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const timeoutMs = clampInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const maxResponseBytes = clampInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
  );
  const url = buildRequestUrl(
    options.baseUrl ?? Global.API_URL,
    endpointPath,
    options.query,
  );
  const coordinator = options.coordinator ?? adminRequestCoordinator;

  const execute = async (): Promise<T> => {
    const bounded = createBoundedSignal(options.signal, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(
          url,
          {
            method,
            credentials: 'same-origin',
            headers,
            body,
            signal: bounded.signal,
          },
        );
      } catch {
        if (bounded.signal.aborted) {
          throw new AdminApiError(
            bounded.timedOut() ? 'timeout' : 'aborted',
            bounded.timedOut()
              ? 'Admin API request timed out.'
              : 'Admin API request was aborted.',
          );
        }
        throw new AdminApiError(
          'network-error',
          'Admin API request could not reach the server.',
        );
      }

      if (!response.ok) {
        const error = responseError(response);
        if (
          redirectOnUnauthorized
          && (error.code === 'unauthenticated' || error.code === 'forbidden')
        ) {
          clearAdminSession();
          safeRedirectToLogin();
        }
        throw error;
      }

      return await parseJsonResponse<T>(response, maxResponseBytes);
    } finally {
      bounded.cleanup();
    }
  };

  try {
    return await coordinator.schedule(execute, {
      singleFlightKey: singleFlightKey(
        method,
        url,
        timeoutMs,
        maxResponseBytes,
        authenticated,
        options.signal,
      ),
      signal: options.signal,
      queueTimeoutMs: Math.min(timeoutMs, MAX_QUEUE_WAIT_MS),
    });
  } catch (error) {
    if (error instanceof AdminRequestCoordinatorError) {
      throw coordinatorError(error);
    }
    throw error;
  }
};

export const adminApiGet = <T>(
  endpointPath: string,
  options: Omit<AdminApiRequestOptions, 'method' | 'body' | 'formData'> = {},
): Promise<T> => adminApiRequest<T>(endpointPath, {
  ...options,
  method: 'GET',
});

export const adminApiPost = <T>(
  endpointPath: string,
  body: unknown,
  options: Omit<AdminApiRequestOptions, 'method' | 'body' | 'formData'> = {},
): Promise<T> => adminApiRequest<T>(endpointPath, {
  ...options,
  method: 'POST',
  body,
});

export const adminApiPostForm = <T>(
  endpointPath: string,
  formData: FormData,
  options: Omit<AdminApiRequestOptions, 'method' | 'body' | 'formData'> = {},
): Promise<T> => adminApiRequest<T>(endpointPath, {
  ...options,
  method: 'POST',
  formData,
});
