export type MapWorkspaceRetryPresentation = 'action' | 'unavailable' | 'exhausted';

export interface MapWorkspaceSafeError {
  readonly message: string | null;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

const DEFAULT_MAX_LENGTH = 180;
const MIN_MAX_LENGTH = 48;
const MAX_MAX_LENGTH = 320;
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/giu;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/gu;
const UNIX_PATH_PATTERN = /(?:^|\s)\/(?:[^\s/]+\/)+[^\s/]+/gu;

const clampLength = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_LENGTH;
  return Math.max(MIN_MAX_LENGTH, Math.min(MAX_MAX_LENGTH, Math.trunc(value ?? DEFAULT_MAX_LENGTH)));
};

const stripControlCharacters = (value: string): string => {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    output += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? ' ' : character;
  }
  return output;
};

const redactSensitiveLocations = (value: string): { readonly value: string; readonly redacted: boolean } => {
  let redacted = false;
  const replace = (match: string): string => {
    redacted = true;
    return match.startsWith(' ') ? ' [ayrıntı gizlendi]' : '[ayrıntı gizlendi]';
  };
  const sanitized = value
    .replace(URL_PATTERN, replace)
    .replace(WINDOWS_PATH_PATTERN, replace)
    .replace(UNIX_PATH_PATTERN, replace);
  return Object.freeze({ value: sanitized, redacted });
};

export const sanitizeMapWorkspaceShellError = (
  value: string | null | undefined,
  maxLength?: number,
): MapWorkspaceSafeError => {
  if (!value) return Object.freeze({ message: null, redacted: false, truncated: false });
  const limit = clampLength(maxLength);
  const compact = stripControlCharacters(value).replace(/\s+/gu, ' ').trim();
  if (!compact) return Object.freeze({ message: null, redacted: false, truncated: false });
  const redaction = redactSensitiveLocations(compact);
  const truncated = redaction.value.length > limit;
  const message = redaction.value.slice(0, limit).trim();
  return Object.freeze({
    message: message || null,
    redacted: redaction.redacted,
    truncated,
  });
};

export const deriveMapWorkspaceRetryPresentation = (
  canRetry: boolean,
  hasRetryAction: boolean,
): MapWorkspaceRetryPresentation => {
  if (!canRetry) return 'exhausted';
  return hasRetryAction ? 'action' : 'unavailable';
};

export const mapWorkspaceRetryMessage = (
  presentation: Exclude<MapWorkspaceRetryPresentation, 'action'>,
): string => {
  if (presentation === 'unavailable') {
    return 'Bu ekranda yeniden başlatma eylemi kullanılamıyor. Bağlantınızı kontrol edip sayfayı yeniden yükleyebilirsiniz.';
  }
  return 'Yeniden deneme güvenlik sınırına ulaşıldı. Bağlantınızı kontrol edip sayfayı yeniden yükleyebilirsiniz.';
};
