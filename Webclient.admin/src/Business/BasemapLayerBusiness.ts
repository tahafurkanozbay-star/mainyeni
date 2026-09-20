import { Constants } from "../Core/Constants";
import { isRecord, type UnknownRecord } from "../platform/contracts";
import {
  bool,
  getLegacy,
  postLegacy,
  recordId,
  requiredText,
  successValidation,
  validHttpUrl,
  type LegacyBusinessMessage,
  type LegacyServiceResponse,
} from "./businessRuntime";

export interface BasemapLayerInput extends UnknownRecord {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
  readonly RequiresSC?: unknown;
  readonly SCUserName?: unknown;
  readonly SCPassword?: unknown;
}

export const BasemapLayerBusiness = Object.freeze({
  List: async (): Promise<LegacyServiceResponse> =>
    getLegacy("/Gis/BasemapLayer/List"),

  Validate: (item: unknown): LegacyBusinessMessage => {
    if (!isRecord(item)) {
      return Object.freeze({ type: Constants.MessageTypes.Error, text: "Altlık harita verisi geçersiz." });
    }

    const titleFailure = requiredText(item.title, "Lütfen başlık giriniz");
    if (titleFailure) return titleFailure;

    const urlFailure = requiredText(item.url, "Lütfen bağlantı adresi (url) giriniz");
    if (urlFailure) return urlFailure;
    if (!validHttpUrl(item.url)) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        text: "Lütfen geçerli bir HTTP/HTTPS bağlantı adresi (url) giriniz",
      });
    }

    if (bool(item.RequiresSC)) {
      const usernameFailure = requiredText(item.SCUserName, "Lütfen kullanıcı adı giriniz");
      if (usernameFailure) return usernameFailure;
      const passwordFailure = requiredText(item.SCPassword, "Lütfen şifre giriniz");
      if (passwordFailure) return passwordFailure;
    }

    return successValidation();
  },

  Save: async (itemDetails: unknown): Promise<LegacyServiceResponse> =>
    postLegacy("/Gis/BasemapLayer/Save", itemDetails),

  Delete: async (item: unknown): Promise<LegacyServiceResponse> => {
    const id = recordId(item);
    if (id === null) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "Silinecek altlık harita kimliği geçersiz.",
        data: null,
      });
    }
    return postLegacy("/Gis/BasemapLayer/Delete", { Id: id });
  },
});
