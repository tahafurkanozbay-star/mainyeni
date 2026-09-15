import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const UserActionPermissionBusiness={

    List: async (_userRole) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/UserActionPermission/List/"+_userRole.id;

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


    Save: async (_userRole, _permissionList) => {

        let _headers = await AuthBusiness.GetRequestHeaders();
        var data={
            Id: _userRole.id,
            ActionIds: _permissionList.map(x=> {return x.id}).join(",")
        }
        
        return new Promise((resolve, reject) => {


            let url = Global.API_URL + "/UserActionPermission/Save";
            
            axios({
                method: "post",
                url: url,
                data: JSON.stringify(data),
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