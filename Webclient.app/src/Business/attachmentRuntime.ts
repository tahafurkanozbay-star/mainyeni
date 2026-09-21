import { isRecord } from './contracts';

export type AttachmentIdentifier = string | number;

const hasOwn = (
  value: Record<string, unknown>,
  key: string,
): boolean => Object.prototype.hasOwnProperty.call(value, key);

const normalizeIdentifier = (
  value: unknown,
): AttachmentIdentifier | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) return undefined;
  return normalized;
};

export const attachmentIdentifierFromAttributes = (
  value: unknown,
): AttachmentIdentifier | undefined => {
  if (!isRecord(value)) return undefined;

  if (hasOwn(value, 'attachmentid')) {
    return normalizeIdentifier(value.attachmentid);
  }
  if (hasOwn(value, 'attachmentId')) {
    return normalizeIdentifier(value.attachmentId);
  }
  return undefined;
};
