import { Constants } from "../Core/Constants";
import { DataHelper, type ExportRecord } from "../Core/Toolbox/DataHelper";
import { isRecord, readString } from "../platform/contracts";
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

const EXPORT_FIELDS = Object.freeze([
  "category",
  "title",
  "url",
  "description",
  "requiresSC",
  "scUserName",
  "scPassword",
  "showInSearch",
  "searchCategoryTitle",
  "isIdentifiable",
  "identifyLayers",
] as const);

export const ConfigServicesBusiness = Object.freeze({
  List: async (): Promise<LegacyServiceResponse> =>
    getLegacy("/Gis/ConfigService/List"),

  Validate: (item: unknown): LegacyBusinessMessage => {
    if (!isRecord(item)) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        text: "Konfigürasyon servisi verisi geçersiz.",
      });
    }

    for (const [value, message] of [
      [item.title, "Lütfen başlık giriniz"],
      [item.category, "Lütfen kategori giriniz"],
      [item.description, "Lütfen tanım giriniz"],
      [item.url, "Lütfen bağlantı adresi (url) giriniz"],
    ] as const) {
      const failure = requiredText(value, message);
      if (failure) return failure;
    }

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

    if (bool(item.showInSearch)) {
      const searchFailure = requiredText(
        item.searchCategoryTitle,
        "Lütfen genel arama kategori başlığını giriniz",
      );
      if (searchFailure) return searchFailure;
    }

    if (bool(item.isIdentifiable)) {
      const layersFailure = requiredText(
        item.identifyLayers,
        "Lütfen bilgi alınabilir katman numaralarını giriniz",
      );
      if (layersFailure) return layersFailure;
    }

    return successValidation();
  },

  Save: async (itemDetails: unknown): Promise<LegacyServiceResponse> =>
    postLegacy("/Gis/ConfigService/Save", itemDetails),

  Delete: async (item: unknown): Promise<LegacyServiceResponse> => {
    const id = recordId(item);
    if (id === null) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "Silinecek servis kimliği geçersiz.",
        data: null,
      });
    }
    return postLegacy("/Gis/ConfigService/Delete", { Id: id });
  },

  Import: async (files: FileList | readonly File[] | null | undefined): Promise<LegacyServiceResponse> => {
    const file = files?.[0] ?? null;
    if (!(file instanceof File)) {
      return Object.freeze({
        type: Constants.MessageTypes.Error,
        message: "İçe aktarılacak dosya seçilmedi.",
        data: null,
      });
    }
    const data = new FormData();
    data.append("file", file, file.name);
    return postLegacy("/Gis/ConfigService/Import", data);
  },

  Export: async (format: unknown): Promise<LegacyServiceResponse> => {
    const normalizedFormat = readString(format) ?? "csv";
    const result = await getLegacy("/Gis/ConfigService/Export", {
      params: { format: normalizedFormat },
    });
    if (normalizedFormat.toLocaleLowerCase("en-US") !== "csv") return result;

    const rawData = result.data;
    if (Array.isArray(rawData)) {
      const rows = rawData.filter(isRecord) as ExportRecord[];
      await DataHelper.ExportJsonToCsv(rows, EXPORT_FIELDS, "configservices.csv");
    }
    return result;
  },
});
