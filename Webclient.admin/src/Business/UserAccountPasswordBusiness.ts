import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiPost } from "../runtime/adminApiClient";

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
        return adminApiPost("/UserAccount/UpdatePassword", {
            id: _itemDetails.id,
            password: _itemDetails.password,
            passwordRepeat: _itemDetails.passwordRepeat,
            sc: "[Security Key]"
        });
    },
};
