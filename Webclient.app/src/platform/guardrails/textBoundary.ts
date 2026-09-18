import type { GuardrailReason, TextBoundaryLimits, TextBoundaryResult } from './contracts';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const BIDI_CONTROL_CHARACTERS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const INVISIBLE_FORMATTING_CHARACTERS = /[\u200B\u200C\u200D\u2060\uFEFF]/gu;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/u;

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
    value = value.replace(INVISIBLE_FORMATTING_CHARACTERS, '');
  }

  if (limits.trim) {
    value = value.trim();
  }

  if (limits.rejectControlCharacters && CONTROL_CHARACTERS.test(value)) {
    reasons.push(reason('control-character', 'Control characters are not allowed.'));
  }

  if (limits.rejectBidiControls && BIDI_CONTROL_CHARACTERS.test(value)) {
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

const FILE_UNSAFE_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F\u007F]/gu;
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

  let value = evaluated.value
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
  CONTROL_CHARACTERS.test(value) ||
  BIDI_CONTROL_CHARACTERS.test(value) ||
  INVISIBLE_FORMATTING_CHARACTERS.test(value);

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
