import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const UserActionBusiness={

    List: async (_key) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserAction/List";

            return axios({
                method: "get",
                url: url,
                headers: _headers
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


    GroupedList: async (_key) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserAction/GroupedList";

            return axios({
                method: "get",
                url: url,
                headers: _headers
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

    Validate:(_item) => {

        if (IsNull(_item.category)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen kategori adı giriniz" };
        }
        if (IsNull(_item.code)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen kod giriniz" };
        }
        if (IsNull(_item.actionType)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen eylem tipi giriniz" };
        }
        if (IsNull(_item.description)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen tanım giriniz" };
        }
        
        return {type:"success",text:""};
    },


    Save: async (_itemDetails) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {


            let url = Global.API_URL + "/UserAction/Save";
            
            axios({
                method: "post",
                url: url,
                data: JSON.stringify(_itemDetails),
                headers: _headers
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

            let url = Global.API_URL + "/UserAction/Delete";

            axios({
                method: "post",
                url: url,
                data: JSON.stringify(_item),
                headers: _headers
            })
                .then(function (response) {
                    var result = response.data;
                    resolve(result);
                })
                .catch(function (error) {
                    return AuthBusiness.HandleRejection(error);
                });
        });
    }

};