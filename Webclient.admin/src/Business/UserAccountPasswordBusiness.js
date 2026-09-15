import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const UserAccountPasswordBusiness={
    
    Validate:(_item)=>{

        if (IsNull(_item.password)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen şifre giriniz" };
        }
        else if (_item.password.length<4 || _item.password.length>16) {
            return { type: Constants.MessageTypes.Error, text: "Şifre en az 4 en fazla 16 karakter olmalıdır" };
        }
        
        if (IsNull(_item.passwordRepeat)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen şifre tekrarı giriniz" };
        }
        if (_item.password!=_item.passwordRepeat) {
            return { type: Constants.MessageTypes.Error, text: "Şifre ve tekrarı uyuşmuyor, lütfen tekrar deneyiniz" };
        }
        
        return {type:"success",text:""};
    },


    Save: async (_itemDetails) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserAccount/UpdatePassword";

            axios({
                method: "post",
                url: url,
                data: JSON.stringify({
                    id: _itemDetails.id,
                    password: _itemDetails.password,
                    passwordRepeat: _itemDetails.passwordRepeat,
                    sc: "[Security Key]"
                }),
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

};