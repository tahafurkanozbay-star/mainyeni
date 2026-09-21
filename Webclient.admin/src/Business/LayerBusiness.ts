import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const LayerBusiness = {
  List: async (_key) => {
    return adminApiGet("/Gis/Layer/List");
  },

  Validate: (_item) => {
    if (_item.GisLayerGroupId<0) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen katman grubu seçiniz",
      };
    }

    if (_item.layerType<0) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen katman tipi seçiniz",
      };
    }
    if (IsNull(_item.description)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen tanım giriniz",
      };
    }
    if (IsNull(_item.title)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen başlık giriniz",
      };
    }
    if (_item.orderPriority<0) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen katman sırasını giriniz",
      };
    }
    if (_item.startupOpacity<=0) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen başlangıç saydamlığı değerini giriniz",
      };
    }

    if (IsNull(_item.url)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen bağlantı adresi (url) giriniz",
      };
    }
    else{
        try{
          Boolean(new URL(_item.url));
        }
        catch(x){
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

    return { type: "success", text: "" };
  },

  Save: async (_itemDetails) => {
    return adminApiPost("/Gis/Layer/Save", _itemDetails);
  },

  Delete: async (_item) => {
    return adminApiPost("/Gis/Layer/Delete", {
      Id: _item.id
    });
  },
};
