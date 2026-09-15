import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";
import {DataHelper} from "../Core/Toolbox/DataHelper";

export const ConfigServicesBusiness = {
  
  List: async (_key) => {
    let _headers = await AuthBusiness.GetRequestHeaders();

    return new Promise((resolve, reject) => {
      let url = Global.API_URL + "/Gis/ConfigService/List";

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
    let _headers = await AuthBusiness.GetRequestHeaders();

    return new Promise((resolve, reject) => {
      let url = Global.API_URL + "/Gis/ConfigService/Save";

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
      let url = Global.API_URL + "/Gis/ConfigService/Delete";

      axios({
        method: "post",
        url: url,
        data: JSON.stringify({
          Id: _item.id
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

  Import: async(_files) => {

    let headers = await AuthBusiness.GetRequestHeaders();
    
    headers["Content-Type"]="multipart/form-data";
    
    
    const data = new FormData()
    data.append('file', _files[0]);
    
    return new Promise((resolve, reject) => {
    
      let url = Global.API_URL + "/Gis/ConfigService/Import";

      let config = {headers};

      axios.post(url, data, config)
        .then(function (response) {
          var result = response.data;
          resolve(result);
        })
        .catch(function (error) {
          return AuthBusiness.HandleRejection(error);
        });
    });

  },

  Export:async(_format)=>{  

      let _headers = await AuthBusiness.GetRequestHeaders();
  
      return new Promise((resolve, reject) => {
        
        let url = Global.API_URL + "/Gis/ConfigService/Export?format="+_format;
  
        return axios({
          method: "get",
          url: url,
          headers: _headers,
        })
          .then(function (response) {
            var result = response.data;
            
            DataHelper.ExportJsonToCsv(result.data,["category","title","url","description","requiresSC","scUserName","scPassword","showInSearch","searchCategoryTitle","isIdentifiable","identifyLayers"],"configservices.csv");

            resolve(result);
          })
          .catch(function (error) {
            reject({
              Type: Constants.MessageTypes.Error,
              Data: error,
            });
          });
      });
  }

};
