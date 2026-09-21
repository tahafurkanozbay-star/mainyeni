import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const UserRoleBusiness={

    List: async (_key) => {
        return adminApiGet("/UserRole/List");
    },

    Validate:(_item) => {
        if (IsNull(_item.Name)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen başlık giriniz" };
        }
     
        return {type:"success",text:""};
    },

    Save: async (_itemDetails) => {
        return adminApiPost("/UserRole/Save", _itemDetails);
    },

    Delete: async (_item) => {
        return adminApiPost("/UserRole/Delete", _item);
    }
};
