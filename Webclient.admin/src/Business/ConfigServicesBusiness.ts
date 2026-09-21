import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { DataHelper } from "../Core/Toolbox/DataHelper";
import {
  adminApiGet,
  adminApiPost,
  adminApiPostForm,
} from "../runtime/adminApiClient";

export const ConfigServicesBusiness = {
  List: async (_key) => {
    return adminApiGet("/Gis/ConfigService/List");
  },

  Validate: (_item) => {
    if (IsNull(_item.title)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen başlık giriniz",
      };
    }

    if (IsNull(_item.category)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen kategori giriniz",
      };
    }

    if (IsNull(_item.description)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen tanım giriniz",
      };
    }

    if (IsNull(_item.url)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen bağlantı adresi (url) giriniz",
      };
    }
    else {
      try {
        Boolean(new URL(_item.url));
      }
      catch (x) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen geçerli bir bağlantı adresi (url) giriniz",
        };
      }
    }

    if (_item.requiresSC) {
      if (IsNull(_item.scUserName)) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen kullanıcı adı giriniz",
        };
      }
      if (IsNull(_item.scPassword)) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen şifre giriniz",
        };
      }
    }

    if (_item.showInSearch) {
      if (IsNull(_item.searchCategoryTitle)) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen genel arama kategori başlığını giriniz",
        };
      }
    }

    if (_item.isIdentifiable) {
      if (IsNull(_item.identifyLayers)) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen bilgi alınabilir katman numaralarını giriniz",
        };
      }
    }

    return { type: "success", text: "" };
  },

  Save: async (_itemDetails) => {
    return adminApiPost("/Gis/ConfigService/Save", _itemDetails);
  },

  Delete: async (_item) => {
    return adminApiPost("/Gis/ConfigService/Delete", {
      Id: _item.id
    });
  },

  Import: async(_files) => {
    const file = _files?.[0];
    if (!file) {
      throw new TypeError("İçe aktarılacak dosya bulunamadı.");
    }

    const data = new FormData();
    data.append('file', file);

    return adminApiPostForm("/Gis/ConfigService/Import", data);
  },

  Export:async(_format)=>{
    const result = await adminApiGet("/Gis/ConfigService/Export", {
      query: { format: _format }
    });

    await DataHelper.ExportJsonToCsv(
      result.data,
      [
        "category",
        "title",
        "url",
        "description",
        "requiresSC",
        "scUserName",
        "showInSearch",
        "searchCategoryTitle",
        "isIdentifiable",
        "identifyLayers"
      ],
      "configservices.csv"
    );

    return result;
  }
};
