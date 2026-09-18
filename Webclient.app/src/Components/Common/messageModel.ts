export type UiMessageSeverity = 'error' | 'warning' | 'success' | 'info';
export type UiMessageVariant = 'danger' | 'warning' | 'success' | 'info';

export interface LegacyMessageInput {
  readonly message?: unknown;
  readonly messageText?: unknown;
  readonly messageType?: unknown;
  readonly type?: unknown;
  readonly createdAt?: unknown;
  readonly id?: unknown;
  readonly [key: string]: unknown;
}

export interface MessageClockParts {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

export interface MessageViewModel {
  readonly id: string | null;
  readonly message: string;
  readonly severity: UiMessageSeverity;
  readonly variant: UiMessageVariant;
  readonly heading: string;
  readonly createdAt: number;
  readonly clock: MessageClockParts;
}

const HEADINGS: Readonly<Record<UiMessageSeverity, string>> = Object.freeze({
  error: 'Hata',
  warning: 'Uyarı',
  success: 'Başarılı',
  info: 'Bilgi',
});

const VARIANTS: Readonly<Record<UiMessageSeverity, UiMessageVariant>> = Object.freeze({
  error: 'danger',
  warning: 'warning',
  success: 'success',
  info: 'info',
});

const text = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
};

export const normalizeMessageSeverity = (value: unknown): UiMessageSeverity => {
  const normalized = text(value).toLowerCase();
  if (normalized === 'error' || normalized === 'danger') return 'error';
  if (normalized === 'warning' || normalized === 'warn') return 'warning';
  if (normalized === 'success' || normalized === 'ok') return 'success';
  return 'info';
};

const timestamp = (value: unknown, now: () => Date): Date => {
  const candidate = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? new Date(value)
      : now();
  if (!Number.isFinite(candidate.getTime())) throw new TypeError('Message timestamp must be valid.');
  return candidate;
};

export const createMessageViewModel = (
  input: LegacyMessageInput | string | null | undefined,
  options: { readonly now?: () => Date } = {},
): MessageViewModel => {
  const source: LegacyMessageInput = typeof input === 'string'
    ? { message: input }
    : input && typeof input === 'object'
      ? input
      : {};
  const severity = normalizeMessageSeverity(source.messageType ?? source.type);
  const date = timestamp(source.createdAt, options.now ?? (() => new Date()));
  return Object.freeze({
    id: text(source.id) || null,
    message: text(source.messageText ?? source.message) || 'Mesaj içeriği bulunamadı.',
    severity,
    variant: VARIANTS[severity],
    heading: HEADINGS[severity],
    createdAt: date.getTime(),
    clock: Object.freeze({
      hours: date.getHours(),
      minutes: date.getMinutes(),
      seconds: date.getSeconds(),
    }),
  });
};

export const formatMessageClock = (clock: MessageClockParts): string =>
  [clock.hours, clock.minutes, clock.seconds]
    .map((value) => String(Math.max(0, Math.trunc(value))).padStart(2, '0'))
    .join(':');
