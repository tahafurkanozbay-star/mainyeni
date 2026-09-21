import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const UserAccountBusiness={

    List: async (_key) => {
        return adminApiGet("/UserAccount/List");
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
        return adminApiPost("/UserAccount/Save", _itemDetails);
    },

    Delete: async (_item) => {
        return adminApiPost("/UserAccount/Delete", _item);
    }
};
