import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const UserActionPermissionBusiness={

    List: async (_userRole) => {
        return adminApiGet(
            `/UserActionPermission/List/${encodeURIComponent(String(_userRole.id))}`
        );
    },

    Save: async (_userRole, _permissionList) => {
        const data={
            Id: _userRole.id,
            ActionIds: _permissionList.map(x=> x.id).join(",")
        };

        return adminApiPost("/UserActionPermission/Save", data);
    }
};
