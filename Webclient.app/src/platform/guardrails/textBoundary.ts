import type { GuardrailReason, TextBoundaryLimits, TextBoundaryResult } from './contracts';

const BIDI_CONTROL_CODE_POINTS = new Set([
  0x061c,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
]);

const INVISIBLE_FORMATTING_CODE_POINTS = new Set([
  0x200b,
  0x200c,
  0x200d,
  0x2060,
  0xfeff,
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/u;

const isControlCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0 && codePoint <= 8) ||
  codePoint === 11 ||
  codePoint === 12 ||
  (codePoint >= 14 && codePoint <= 31) ||
  codePoint === 127;

const containsCodePoint = (
  value: string,
  predicate: (codePoint: number) => boolean,
): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && predicate(codePoint)) return true;
  }
  return false;
};

const removeCodePoints = (
  value: string,
  blocked: ReadonlySet<number>,
): string => {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || blocked.has(codePoint)) continue;
    output += character;
  }
  return output;
};

const replaceControlCharacters = (
  value: string,
  replacement: string,
): string => {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    output += codePoint !== undefined && isControlCodePoint(codePoint)
      ? replacement
      : character;
  }
  return output;
};

const hasControlCharacters = (value: string): boolean =>
  containsCodePoint(value, isControlCodePoint);

const hasBidiControlCharacters = (value: string): boolean =>
  containsCodePoint(value, (codePoint) => BIDI_CONTROL_CODE_POINTS.has(codePoint));

const hasInvisibleFormatting = (value: string): boolean =>
  containsCodePoint(value, (codePoint) => INVISIBLE_FORMATTING_CODE_POINTS.has(codePoint));

export const DEFAULT_TEXT_BOUNDARY_LIMITS: TextBoundaryLimits = Object.freeze({
  maxCodeUnits: 4_096,
  maxUtf8Bytes: 16_384,
  rejectControlCharacters: true,
  rejectBidiControls: true,
  stripInvisibleFormatting: true,
  trim: true,
  normalizeUnicode: true,
});

const reason = (
  code: string,
  message: string,
  severity: GuardrailReason['severity'] = 'error',
  path?: string,
): GuardrailReason => Object.freeze({
  code,
  message,
  severity,
  ...(path ? { path } : {}),
});

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

export const estimateUtf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const normalizeTextBoundaryLimits = (
  input: Partial<TextBoundaryLimits> = {},
): TextBoundaryLimits => Object.freeze({
  maxCodeUnits: positiveInt(
    input.maxCodeUnits ?? DEFAULT_TEXT_BOUNDARY_LIMITS.maxCodeUnits,
    DEFAULT_TEXT_BOUNDARY_LIMITS.maxCodeUnits,
  ),
  maxUtf8Bytes: positiveInt(
    input.maxUtf8Bytes ?? DEFAULT_TEXT_BOUNDARY_LIMITS.maxUtf8Bytes,
    DEFAULT_TEXT_BOUNDARY_LIMITS.maxUtf8Bytes,
  ),
  rejectControlCharacters:
    input.rejectControlCharacters ?? DEFAULT_TEXT_BOUNDARY_LIMITS.rejectControlCharacters,
  rejectBidiControls:
    input.rejectBidiControls ?? DEFAULT_TEXT_BOUNDARY_LIMITS.rejectBidiControls,
  stripInvisibleFormatting:
    input.stripInvisibleFormatting ?? DEFAULT_TEXT_BOUNDARY_LIMITS.stripInvisibleFormatting,
  trim: input.trim ?? DEFAULT_TEXT_BOUNDARY_LIMITS.trim,
  normalizeUnicode:
    input.normalizeUnicode ?? DEFAULT_TEXT_BOUNDARY_LIMITS.normalizeUnicode,
});

export const evaluateTextBoundary = (
  input: unknown,
  options: Partial<TextBoundaryLimits> = {},
): TextBoundaryResult => {
  const limits = normalizeTextBoundaryLimits(options);

  if (typeof input !== 'string') {
    return Object.freeze({
      accepted: false,
      value: '',
      originalLength: 0,
      utf8Bytes: 0,
      changed: false,
      reasons: Object.freeze([
        reason('invalid-input', 'Expected a string value.'),
      ]),
    });
  }

  const original = input;
  let value = input;
  const reasons: GuardrailReason[] = [];

  if (limits.normalizeUnicode) {
    value = value.normalize('NFKC');
  }

  if (limits.stripInvisibleFormatting) {
    value = removeCodePoints(value, INVISIBLE_FORMATTING_CODE_POINTS);
  }

  if (limits.trim) {
    value = value.trim();
  }

  if (limits.rejectControlCharacters && hasControlCharacters(value)) {
    reasons.push(reason('control-character', 'Control characters are not allowed.'));
  }

  if (limits.rejectBidiControls && hasBidiControlCharacters(value)) {
    reasons.push(reason('bidi-control', 'Bidirectional formatting controls are not allowed.'));
  }

  if (value.length > limits.maxCodeUnits) {
    reasons.push(reason('input-too-long', 'Text exceeds the configured code-unit budget.'));
  }

  const utf8Bytes = estimateUtf8Bytes(value);
  if (utf8Bytes > limits.maxUtf8Bytes) {
    reasons.push(reason('input-too-large', 'Text exceeds the configured byte budget.'));
  }

  return Object.freeze({
    accepted: reasons.length === 0,
    value,
    originalLength: original.length,
    utf8Bytes,
    changed: value !== original,
    reasons: Object.freeze(reasons),
  });
};

export interface HeaderBoundaryOptions {
  readonly maxNameLength?: number;
  readonly maxValueLength?: number;
}

export interface HeaderBoundaryResult {
  readonly accepted: boolean;
  readonly name: string;
  readonly value: string;
  readonly bytes: number;
  readonly reasons: readonly GuardrailReason[];
}

export const evaluateHeaderBoundary = (
  nameInput: unknown,
  valueInput: unknown,
  options: HeaderBoundaryOptions = {},
): HeaderBoundaryResult => {
  const maxNameLength = positiveInt(options.maxNameLength ?? 128, 128);
  const maxValueLength = positiveInt(options.maxValueLength ?? 8_192, 8_192);
  const nameResult = evaluateTextBoundary(nameInput, {
    maxCodeUnits: maxNameLength,
    maxUtf8Bytes: maxNameLength * 4,
    rejectControlCharacters: true,
    rejectBidiControls: true,
    stripInvisibleFormatting: false,
    trim: true,
    normalizeUnicode: false,
  });
  const valueResult = evaluateTextBoundary(valueInput, {
    maxCodeUnits: maxValueLength,
    maxUtf8Bytes: maxValueLength * 4,
    rejectControlCharacters: true,
    rejectBidiControls: true,
    stripInvisibleFormatting: true,
    trim: true,
    normalizeUnicode: true,
  });
  const reasons = [...nameResult.reasons, ...valueResult.reasons];
  const name = nameResult.value.toLowerCase();
  const value = valueResult.value;

  if (name.length === 0 || !HEADER_NAME_PATTERN.test(name)) {
    reasons.push(reason('invalid-header-name', 'Header name contains invalid characters.'));
  }

  if (/[\r\n]/u.test(value)) {
    reasons.push(reason('invalid-header-value', 'Header value must not contain CR or LF characters.'));
  }

  return Object.freeze({
    accepted: reasons.length === 0,
    name,
    value,
    bytes: estimateUtf8Bytes(name) + estimateUtf8Bytes(value),
    reasons: Object.freeze(reasons),
  });
};

const FILE_UNSAFE_CHARACTERS = /[<>:"/\\|?*]/gu;
const FILE_TRAILING_DOTS_OR_SPACES = /[. ]+$/u;
const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export interface FileNameBoundaryResult {
  readonly accepted: boolean;
  readonly value: string;
  readonly changed: boolean;
  readonly reasons: readonly GuardrailReason[];
}

export const sanitizeFileName = (
  input: unknown,
  maxLength = 180,
): FileNameBoundaryResult => {
  const limit = positiveInt(maxLength, 180);
  const evaluated = evaluateTextBoundary(input, {
    maxCodeUnits: limit,
    maxUtf8Bytes: limit * 4,
    rejectControlCharacters: true,
    rejectBidiControls: true,
    stripInvisibleFormatting: true,
    trim: true,
    normalizeUnicode: true,
  });

  let value = replaceControlCharacters(evaluated.value, '_')
    .replace(FILE_UNSAFE_CHARACTERS, '_')
    .replace(FILE_TRAILING_DOTS_OR_SPACES, '');

  if (value === '.' || value === '..' || RESERVED_FILE_NAMES.test(value)) {
    value = '_' + value.replace(/\.+/gu, '_');
  }

  if (value.length === 0) value = 'unnamed';

  const reasons = [...evaluated.reasons];
  if (value !== evaluated.value) {
    reasons.push(reason('normalized-file-name', 'Unsafe file-name characters were normalized.', 'warning'));
  }

  return Object.freeze({
    accepted: evaluated.accepted,
    value,
    changed: value !== input,
    reasons: Object.freeze(reasons),
  });
};

export const hasSensitiveUnicodeFormatting = (value: string): boolean =>
  hasControlCharacters(value) ||
  hasBidiControlCharacters(value) ||
  hasInvisibleFormatting(value);

export const truncateUtf8 = (
  value: string,
  maxBytes: number,
): string => {
  const limit = positiveInt(maxBytes, 1);
  if (estimateUtf8Bytes(value) <= limit) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateUtf8Bytes(value.slice(0, middle)) <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
};
