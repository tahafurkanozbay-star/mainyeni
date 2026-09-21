import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const BasemapLayerBusiness = {
  List: async (_key) => {
    return adminApiGet("/Gis/BasemapLayer/List");
  },

  Validate: (_item) => {
    if (IsNull(_item.title)) {
      return {
        type: Constants.MessageTypes.Error,
        text: "Lütfen başlık giriniz",
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

    if (_item.RequiresSC) {
      if (IsNull(_item.SCUserName)) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen kullanıcı adı giriniz",
        };
      }
      if (IsNull(_item.SCPassword)) {
        return {
          type: Constants.MessageTypes.Error,
          text: "Lütfen şifre giriniz",
        };
      }
    }

    return { type: "success", text: "" };
  },

  Save: async (_itemDetails) => {
    return adminApiPost("/Gis/BasemapLayer/Save", _itemDetails);
  },

  Delete: async (_item) => {
    return adminApiPost("/Gis/BasemapLayer/Delete", {
      Id: _item.id
    });
  },
};
