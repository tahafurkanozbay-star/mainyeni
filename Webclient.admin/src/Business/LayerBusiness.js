import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const LayerBusiness = {
  List: async (_key) => {
    let _headers = await AuthBusiness.GetRequestHeaders();

    return new Promise((resolve, reject) => {
      let url = Global.API_URL + "/Gis/Layer/List";

      return axios({
        method: "get",
        url: url,
        headers: _headers,
      })
        .then(function (response) {
          var result = response.data;
          resolve(result);
        })
        .catch(function (error) {
          return AuthBusiness.HandleRejection(error);
        });
    });
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
    let _headers = await AuthBusiness.GetRequestHeaders();

    return new Promise((resolve, reject) => {
      let url = Global.API_URL + "/Gis/Layer/Save";

      axios({
        method: "post",
        url: url,
        data: JSON.stringify(_itemDetails),
        headers: _headers,
      })
        .then(function (response) {
          var result = response.data;
          resolve(result);
        })
        .catch(function (error) {
          return AuthBusiness.HandleRejection(error);
        });
    });
  },

  Delete: async (_item) => {
    let _headers = await AuthBusiness.GetRequestHeaders();

    return new Promise((resolve, reject) => {
      let url = Global.API_URL + "/Gis/Layer/Delete";

      axios({
        method: "post",
        url: url,
        data: JSON.stringify({
          Id:_item.id
        }),
        headers: _headers,
      })
        .then(function (response) {
          var result = response.data;
          resolve(result);
        })
        .catch(function (error) {
          return AuthBusiness.HandleRejection(error);
        });
    });
  },
};
