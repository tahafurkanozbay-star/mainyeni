import { Constants } from "../Core/Constants";
import {
  getLegacy,
  postLegacy,
  recordId,
  requiredText,
  successValidation,
  type LegacyBusinessMessage,
  type LegacyServiceResponse,
} from "./businessRuntime";
import { isRecord } from "../platform/contracts";

export const LayerGroupBusiness = Object.freeze({
  List: async (): Promise<LegacyServiceResponse> =>
    getLegacy("/Gis/LayerGroup/List"),

  ListWithLayers: async (): Promise<LegacyServiceResponse> =>
    getLegacy("/Gis/LayerGroup/ListWithLayers"),

  Validate: (item: unknown): LegacyBusinessMessage => {
    if (!isRecord(item)) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        text: "Katman grubu verisi geçersiz.",
      });
    }
    return requiredText(item.title, "Lütfen başlık giriniz") ?? successValidation();
  },

  Save: async (itemDetails: unknown): Promise<LegacyServiceResponse> =>
    postLegacy("/Gis/LayerGroup/Save", itemDetails),

  Delete: async (item: unknown): Promise<LegacyServiceResponse> => {
    const id = recordId(item);
    if (id === null) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "Silinecek katman grubu kimliği geçersiz.",
        data: null,
      });
    }
    return postLegacy("/Gis/LayerGroup/Delete", { id });
  },
});
