import type {
  ResourceCategory,
  ResourceOriginKind,
  WebVitalMeasurement,
} from './contracts';

export const finiteNumber = (value: unknown, fallback: number | null = null): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const nonNegativeNumber = (value: unknown, fallback = 0): number => {
  const parsed = finiteNumber(value, fallback);
  return parsed === null ? fallback : Math.max(0, parsed);
};

export const boundedNumber = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  const parsed = finiteNumber(value, fallback) ?? fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

export const boundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => Math.trunc(boundedNumber(value, minimum, maximum, fallback));

export const safeRatio = (numerator: unknown, denominator: unknown): number => {
  const top = nonNegativeNumber(numerator, 0);
  const bottom = nonNegativeNumber(denominator, 0);
  return bottom > 0 ? top / bottom : 0;
};

const stripControlCharacters = (value: string): string => {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) continue;
    output += character;
  }
  return output;
};

export const safeText = (value: unknown, maximumLength = 120): string => {
  const text = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);
  return stripControlCharacters(text)
    .trim()
    .slice(0, Math.max(0, maximumLength));
};

export const stableUnique = (values: readonly string[]): string[] =>
  Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right, 'en'));

export const roundMetric = (value: unknown, digits = 2): number | null => {
  const parsed = finiteNumber(value, null);
  if (parsed === null) return null;
  const safeDigits = boundedInteger(digits, 0, 8, 2);
  const scale = 10 ** safeDigits;
  return Math.round(parsed * scale) / scale;
};

export const classifyResourceCategory = (initiatorType: unknown): ResourceCategory => {
  const type = safeText(initiatorType, 40).toLowerCase();
  switch (type) {
    case 'script':
    case 'link':
      return type === 'link' ? 'style' : 'script';
    case 'css':
      return 'style';
    case 'img':
    case 'image':
      return 'image';
    case 'font':
      return 'font';
    case 'fetch':
      return 'fetch';
    case 'xmlhttprequest':
      return 'xmlhttprequest';
    case 'navigation':
      return 'navigation';
    case 'worker':
      return 'worker';
    default:
      return 'other';
  }
};

const normalizeOrigin = (value: string): string | null => {
  try {
    const parsed = new URL(value, 'https://localhost.invalid');
    if (!/^https?:$/iu.test(parsed.protocol)) return null;
    return parsed.origin === 'https://localhost.invalid' ? null : parsed.origin;
  } catch {
    return null;
  }
};

export const classifyResourceOrigin = (
  resourceName: unknown,
  locationOrigin: unknown,
): { kind: ResourceOriginKind; origin: string | null } => {
  const name = safeText(resourceName, 2_048);
  const currentOrigin = safeText(locationOrigin, 512);
  if (!name) return { kind: 'unknown', origin: null };
  if (name.startsWith('data:') || name.startsWith('blob:')) return { kind: 'opaque', origin: null };

  try {
    const parsed = new URL(name, currentOrigin || 'https://localhost.invalid');
    if (!/^https?:$/iu.test(parsed.protocol)) return { kind: 'opaque', origin: null };
    const origin = normalizeOrigin(parsed.href);
    if (!origin) return { kind: 'unknown', origin: null };
    const normalizedCurrent = normalizeOrigin(currentOrigin);
    if (normalizedCurrent && origin === normalizedCurrent) return { kind: 'same-origin', origin };
    return { kind: 'cross-origin', origin };
  } catch {
    return { kind: 'unknown', origin: null };
  }
};

export const isRenderBlockingResource = (
  category: ResourceCategory,
  initiatorType: unknown,
): boolean => {
  const type = safeText(initiatorType, 40).toLowerCase();
  return category === 'style'
    || type === 'css'
    || type === 'link'
    || (category === 'script' && type === 'script');
};

export const normalizeNavigationType = (value: unknown): string => {
  const normalized = safeText(value, 40).toLowerCase();
  return normalized || 'unknown';
};

export const normalizeVitalRating = (value: unknown): WebVitalMeasurement['rating'] => {
  const rating = safeText(value, 32).toLowerCase();
  if (rating === 'good' || rating === 'needs-improvement' || rating === 'poor') return rating;
  return 'unknown';
};

export const normalizeVitalName = (value: unknown): WebVitalMeasurement['name'] | null => {
  const name = safeText(value, 12).toUpperCase();
  return name === 'CLS' || name === 'FCP' || name === 'INP' || name === 'LCP' || name === 'TTFB'
    ? name
    : null;
};

export const stableObjectString = (value: Readonly<Record<string, unknown>>): string =>
  Object.keys(value)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(key => `${key}=${String(value[key] ?? '')}`)
    .join('|');

export const hashString = (value: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
