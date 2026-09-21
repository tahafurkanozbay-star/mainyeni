import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const LayerGroupBusiness={

    List: async (_key) => {
        return adminApiGet("/Gis/LayerGroup/List");
    },

    ListWithLayers: async (_key) => {
        return adminApiGet("/Gis/LayerGroup/ListWithLayers");
    },

    Validate:(_item) => {
        if (IsNull(_item.title)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen başlık giriniz" };
        }

        return {type:"success",text:""};
    },

    Save: async (_itemDetails) => {
        return adminApiPost("/Gis/LayerGroup/Save", _itemDetails);
    },

    Delete: async (_item) => {
        return adminApiPost("/Gis/LayerGroup/Delete", {
            id: _item.id
        });
    }
};
