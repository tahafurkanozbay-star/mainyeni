import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const UserActionBusiness={

    List: async (_key) => {
        return adminApiGet("/UserAction/List");
    },

    GroupedList: async (_key) => {
        return adminApiGet("/UserAction/GroupedList");
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
        return adminApiPost("/UserAction/Save", _itemDetails);
    },

    Delete: async (_item) => {
        return adminApiPost("/UserAction/Delete", _item);
    }
};
