import type { AxiosRequestConfig } from "axios";
import { Constants, type MessageType } from "../Core/Constants";
import { adminHttpClient } from "../platform/httpClient";
import {
  isRecord,
  normalizeIdentifier,
  readBoolean,
  readFiniteNumber,
  readString,
  type UnknownRecord,
} from "../platform/contracts";
import { AuthBusiness } from "./AuthBusiness";

export interface LegacyBusinessMessage {
  readonly type: MessageType | "success";
  readonly text: string;
}

export type LegacyServiceResponse = UnknownRecord;

const asLegacyResponse = (value: unknown): LegacyServiceResponse =>
  isRecord(value)
    ? value
    : Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "Sunucudan geçersiz yanıt alındı.",
        data: null,
      });

const runLegacy = async (
  operation: () => Promise<{ readonly data: unknown }>,
): Promise<LegacyServiceResponse> => {
  try {
    const response = await operation();
    return asLegacyResponse(response.data);
  } catch (error) {
    return AuthBusiness.HandleRejection(error);
  }
};

export const getLegacy = async (
  path: string,
  config?: AxiosRequestConfig,
): Promise<LegacyServiceResponse> =>
  runLegacy(() => adminHttpClient.get<unknown>(path, config));

export const postLegacy = async (
  path: string,
  data: unknown,
  config?: AxiosRequestConfig,
): Promise<LegacyServiceResponse> =>
  runLegacy(() => adminHttpClient.post<unknown>(path, data, config));

export const requiredText = (
  value: unknown,
  message: string,
): LegacyBusinessMessage | null =>
  readString(value) === null
    ? Object.freeze({ type: Constants.MessageTypes.Error, text: message })
    : null;

export const invalidNumber = (
  value: unknown,
  predicate: (value: number) => boolean,
  message: string,
): LegacyBusinessMessage | null => {
  const parsed = readFiniteNumber(value);
  return parsed === null || predicate(parsed)
    ? Object.freeze({ type: Constants.MessageTypes.Error, text: message })
    : null;
};

export const successValidation = (): LegacyBusinessMessage =>
  Object.freeze({ type: "success", text: "" });

export const validHttpUrl = (value: unknown): boolean => {
  const text = readString(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

export const recordId = (value: unknown): string | number | null => {
  if (!isRecord(value)) return null;
  return normalizeIdentifier(value.id ?? value.Id ?? value.ID);
};

export const bool = (value: unknown): boolean =>
  readBoolean(value) ?? false;

export const record = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : Object.freeze({});
