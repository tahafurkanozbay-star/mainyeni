import { Constants } from "../Core/Constants";
import { isRecord } from "../platform/contracts";
import {
  bool,
  getLegacy,
  invalidNumber,
  postLegacy,
  recordId,
  requiredText,
  successValidation,
  validHttpUrl,
  type LegacyBusinessMessage,
  type LegacyServiceResponse,
} from "./businessRuntime";

export const LayerBusiness = Object.freeze({
  List: async (): Promise<LegacyServiceResponse> =>
    getLegacy("/Gis/Layer/List"),

  Validate: (item: unknown): LegacyBusinessMessage => {
    if (!isRecord(item)) {
      return Object.freeze({ type: Constants.MessageTypes.Error, text: "Katman verisi geçersiz." });
    }

    const groupFailure = invalidNumber(
      item.GisLayerGroupId,
      (value) => value < 0,
      "Lütfen katman grubu seçiniz",
    );
    if (groupFailure) return groupFailure;

    const typeFailure = invalidNumber(
      item.layerType,
      (value) => value < 0,
      "Lütfen katman tipi seçiniz",
    );
    if (typeFailure) return typeFailure;

    for (const [value, message] of [
      [item.description, "Lütfen tanım giriniz"],
      [item.title, "Lütfen başlık giriniz"],
    ] as const) {
      const failure = requiredText(value, message);
      if (failure) return failure;
    }

    const orderFailure = invalidNumber(
      item.orderPriority,
      (value) => value < 0,
      "Lütfen katman sırasını giriniz",
    );
    if (orderFailure) return orderFailure;

    const opacityFailure = invalidNumber(
      item.startupOpacity,
      (value) => value <= 0 || value > 100,
      "Lütfen 1-100 arasında başlangıç saydamlığı değeri giriniz",
    );
    if (opacityFailure) return opacityFailure;

    const urlFailure = requiredText(item.url, "Lütfen bağlantı adresi (url) giriniz");
    if (urlFailure) return urlFailure;
    if (!validHttpUrl(item.url)) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        text: "Lütfen geçerli bir HTTP/HTTPS bağlantı adresi (url) giriniz",
      });
    }

    if (bool(item.requiresSC)) {
      const usernameFailure = requiredText(item.scUserName, "Lütfen kullanıcı adı giriniz");
      if (usernameFailure) return usernameFailure;
      const passwordFailure = requiredText(item.scPassword, "Lütfen şifre giriniz");
      if (passwordFailure) return passwordFailure;
    }

    return successValidation();
  },

  Save: async (itemDetails: unknown): Promise<LegacyServiceResponse> =>
    postLegacy("/Gis/Layer/Save", itemDetails),

  Delete: async (item: unknown): Promise<LegacyServiceResponse> => {
    const id = recordId(item);
    if (id === null) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "Silinecek katman kimliği geçersiz.",
        data: null,
      });
    }
    return postLegacy("/Gis/Layer/Delete", { Id: id });
  },
});
