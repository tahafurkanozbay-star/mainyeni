import { Constants } from "../Core/Constants";
import { isRecord, readString, type UnknownRecord } from "../platform/contracts";
import {
  getLegacy,
  postLegacy,
  requiredText,
  successValidation,
  type LegacyBusinessMessage,
  type LegacyServiceResponse,
} from "./businessRuntime";

export interface GisMapConfig extends UnknownRecord {
  readonly Centerx?: unknown;
  readonly Centery?: unknown;
  readonly Zoom?: unknown;
  readonly DefaultBasemapTitle?: unknown;
}

export interface GisTakbisConfig extends UnknownRecord {
  readonly ServiceUrl?: unknown;
  readonly CityId?: unknown;
  readonly ClientUserName?: unknown;
  readonly ClientPassword?: unknown;
  readonly Host?: unknown;
  readonly Token?: unknown;
}

export interface AppConfig extends UnknownRecord {
  readonly AppTitle?: unknown;
}

export interface AppSettingPayload extends UnknownRecord {
  readonly ConfigKey: string;
  readonly ConfigValue: string;
}

const validateRequiredFields = (
  value: unknown,
  fields: ReadonlyArray<readonly [string, string]>,
): LegacyBusinessMessage | null => {
  if (!isRecord(value)) {
    return Object.freeze({
      type: Constants.MessageTypes.Error,
      text: "Ayar verisi geçersiz.",
    });
  }
  for (const [field, message] of fields) {
    const failure = requiredText(value[field], message);
    if (failure) return failure;
  }
  return null;
};

export const SettingsBusiness = Object.freeze({
  Get: async (key: unknown): Promise<LegacyServiceResponse> => {
    const normalized = readString(key);
    if (!normalized) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "Ayar anahtarı boş olamaz.",
        data: null,
      });
    }
    return getLegacy("/AppSettings/List", {
      params: { key: normalized },
    });
  },

  Save: async (config: unknown): Promise<LegacyServiceResponse> =>
    postLegacy("/AppSettings/Save", config),

  ValidateGisMapConfig: (config: unknown): LegacyBusinessMessage =>
    validateRequiredFields(config, [
      ["Centerx", "Lütfen başlangıç merkez noktası X için koordinat giriniz"],
      ["Centery", "Lütfen başlangıç merkez noktası Y için koordinat giriniz"],
      ["Zoom", "Lütfen zoom değeri giriniz"],
      ["DefaultBasemapTitle", "Lütfen altlık harita seçiniz"],
    ]) ?? successValidation(),

  ValidateGisTakbisConfig: (config: unknown): LegacyBusinessMessage =>
    validateRequiredFields(config, [
      ["ServiceUrl", "Lütfen servis adresi giriniz"],
      ["CityId", "Lütfen şehir id giriniz"],
      ["ClientUserName", "Lütfen kullanıcı adı giriniz"],
      ["ClientPassword", "Lütfen şifre giriniz"],
      ["Host", "Lütfen host giriniz"],
      ["Token", "Lütfen token giriniz"],
    ]) ?? successValidation(),

  ValidateAppConfig: (config: unknown): LegacyBusinessMessage =>
    validateRequiredFields(config, [
      ["AppTitle", "Lütfen uygulama başlığını giriniz"],
    ]) ?? successValidation(),
});
