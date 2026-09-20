export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type UnknownRecord = Record<string, unknown>;

export interface AdminSession {
  readonly accessToken: string;
  readonly userName?: string;
  readonly expiresAt?: string;
  readonly roles?: readonly string[];
}

export interface LoginResponse {
  readonly isSuccess: boolean;
  readonly data?: unknown;
  readonly message?: string;
}

export interface ServiceResult<T> {
  readonly isSuccess: boolean;
  readonly data: T | null;
  readonly message: string | null;
  readonly raw: unknown;
}

export interface AdminMessage {
  readonly type: number;
  readonly text: string;
}

export interface RequestFailure {
  readonly kind: "aborted" | "timeout" | "unauthorized" | "forbidden" | "network" | "http" | "invalid-response" | "unknown";
  readonly status: number | null;
  readonly message: string;
  readonly retriable: boolean;
  readonly cause?: unknown;
}

export const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const readString = (
  value: unknown,
  options: { trim?: boolean; allowEmpty?: boolean } = {},
): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  const normalized = options.trim === false ? text : text.trim();
  if (!options.allowEmpty && normalized.length === 0) return null;
  return normalized;
};

export const readFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const readBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return null;
};

export const readStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return Object.freeze(
    value
      .map((item) => readString(item))
      .filter((item): item is string => item !== null),
  );
};

export const asAdminSession = (value: unknown): AdminSession | null => {
  if (!isRecord(value)) return null;
  const accessToken = readString(value.accessToken);
  if (!accessToken) return null;

  const userName = readString(value.userName);
  const expiresAt = readString(value.expiresAt);
  const roles = readStringArray(value.roles);

  return Object.freeze({
    accessToken,
    ...(userName ? { userName } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(roles.length ? { roles } : {}),
  });
};

export const asLoginResponse = (value: unknown): LoginResponse | null => {
  if (!isRecord(value)) return null;
  const isSuccess = readBoolean(value.isSuccess);
  if (isSuccess === null) return null;
  const message = readString(value.message);
  return Object.freeze({
    isSuccess,
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
    ...(message ? { message } : {}),
  });
};

export const normalizeServiceResult = <T>(
  value: unknown,
  parse: (value: unknown) => T | null,
): ServiceResult<T> => {
  if (!isRecord(value)) {
    return Object.freeze({
      isSuccess: false,
      data: null,
      message: "Geçersiz servis yanıtı.",
      raw: value,
    });
  }

  const success = readBoolean(value.isSuccess)
    ?? (readFiniteNumber(value.type) === 10 ? true : null)
    ?? false;
  const candidate = Object.hasOwn(value, "data") ? value.data : value.Data;
  const data = parse(candidate);
  const message = readString(value.message ?? value.Message);

  return Object.freeze({
    isSuccess: success && data !== null,
    data,
    message,
    raw: value,
  });
};

export const normalizeText = (value: unknown, fallback = ""): string =>
  readString(value) ?? fallback;

export const normalizeIdentifier = (value: unknown): string | number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = readString(value);
  return text ?? null;
};

export const safeErrorMessage = (error: unknown, fallback = "Beklenmeyen bir hata oluştu."): string => {
  if (error instanceof Error) return readString(error.message) ?? fallback;
  if (isRecord(error)) return readString(error.message) ?? fallback;
  return readString(error) ?? fallback;
};

export const toJsonSafe = (
  value: unknown,
  depth = 0,
  maxDepth = 4,
  maxItems = 50,
): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (depth >= maxDepth) return "[depth-limit]";
  if (Array.isArray(value)) {
    return Object.freeze(
      value.slice(0, maxItems).map((item) => toJsonSafe(item, depth + 1, maxDepth, maxItems)),
    );
  }
  if (!isRecord(value)) return String(value);

  const result: Record<string, JsonValue> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= maxItems) {
      result.__truncated__ = true;
      break;
    }
    result[key] = toJsonSafe(item, depth + 1, maxDepth, maxItems);
    count += 1;
  }
  return Object.freeze(result);
};
