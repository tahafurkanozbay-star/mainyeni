import { AppError } from '../errors/appError';

export const isSameOriginPath = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\');
};

export const assertApplicationEndpoint = (value) => {
  if (!isSameOriginPath(value)) {
    throw new AppError('Cross-origin application endpoint is blocked.', {
      code: 'CROSS_ORIGIN_BLOCKED',
      retryable: false
    });
  }
  return value;
};

export const normalizeApplicationPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '/';

  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//') || raw.includes('\\')) {
    return assertApplicationEndpoint(raw);
  }

  const path = `/${raw.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return assertApplicationEndpoint(path);
};
