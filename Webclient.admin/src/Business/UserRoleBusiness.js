import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const UserRoleBusiness={

    List: async (_key) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserRole/List";

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

        if (IsNull(_item.Name)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen başlık giriniz" };
        }
     
        return {type:"success",text:""};

    },


    Save: async (_itemDetails) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserRole/Save";

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

            let url = Global.API_URL + "/UserRole/Delete";

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