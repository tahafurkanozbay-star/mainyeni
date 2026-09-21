import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const LayerPermissionBusiness={

    List: async (_userRole) => {
        return adminApiGet(
            `/GisLayerPermission/List/${encodeURIComponent(String(_userRole.id))}`
        );
    },

    Save: async (_userRole, _permissionList) => {
        const data={
            Id: _userRole.id,
            LayerIds: _permissionList.map(x=> x.id).join(",")
        };

        return adminApiPost("/GisLayerPermission/Save", data);
    }
};
