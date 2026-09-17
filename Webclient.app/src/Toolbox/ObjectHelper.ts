export const IsNull = (obj: unknown): boolean =>
  obj === null || obj === undefined || obj === '' || obj === 'Null' || obj === 'null';

export const HasNumeric = (obj: unknown): boolean => /\d/u.test(String(obj ?? ''));

export const IsNumeric = (obj: unknown): boolean => {
  if (obj === null || obj === undefined || obj === '') return false;
  const parsed = Number.parseFloat(String(obj));
  return !Number.isNaN(parsed) && Number.isFinite(Number(obj));
};

export const IsInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

export const IsFloat = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value);

export const IsAlphabetic = (obj: unknown): boolean => /^[a-zA-Z() ]+$/u.test(String(obj ?? ''));

export const clone = <TValue>(obj: TValue): TValue => {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => clone(item)) as TValue;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    copy[key] = value !== null && typeof value === 'object'
      ? Object.assign(Array.isArray(value) ? [] : {}, value)
      : value;
  }
  return copy as TValue;
};
