export function IsNull(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized === "" || normalized.toLocaleLowerCase("en-US") === "null";
}

export function HasNumeric(value: unknown): boolean {
  return /\d/u.test(String(value ?? ""));
}

export function IsNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

export function IsInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

export function IsFloat(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value);
}

export function IsAlphabetic(value: unknown): boolean {
  return typeof value === "string" && /^[a-zA-Z() ]+$/u.test(value);
}

export function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return [...value] as T;
  return { ...(value as Record<PropertyKey, unknown>) } as T;
}
