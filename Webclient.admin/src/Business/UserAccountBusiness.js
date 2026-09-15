import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const UserAccountBusiness={

    List: async (_key) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserAccount/List";

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

        if (IsNull(_item.userName)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen kullanıcı adı giriniz" };
        }
        if (IsNull(_item.firstName)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen ad giriniz" };
        }
        if (IsNull(_item.lastName)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen soyadı giriniz" };
        }
        if (IsNull(_item.roles)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen en az bir rol seçiniz" };
        }
        if (IsNull(_item.accountType)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen kullanıcı tipini seçiniz" };
        }
        
        return {type:"success",text:""};
    },


    Save: async (_itemDetails) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {


            let url = Global.API_URL + "/UserAccount/Save";
            
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

            let url = Global.API_URL + "/UserAccount/Delete";

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