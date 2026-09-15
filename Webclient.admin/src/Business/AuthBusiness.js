import axios from "axios";
import { Global } from "../Core/Global";
import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import CryptoJS from 'crypto-js';

export const AuthBusiness = {

    LoginUser: async (_username, _password) => {

        return new Promise(resolve => {

            let url = Global.API_URL + '/Auth/Login';

            var data = new FormData();
            data.append("UserName", _username);
            data.append("Password", _password);

            axios.post(url, data).then(function (response) {

                var result = response.data;
                resolve(result);

            }).catch(function (error) {

                console.log(error);
                resolve(null);

            });
        });
    },

    LogoutUser: () => {

        localStorage.removeItem(Constants.Session.SessionObjectTitle);
        window.location.reload();

        /*let _headers = await GetRequestHeaders();
        
        return new Promise((resolve) => {
          let url = process.env.REACT_APP_API_HOST + "/Auth/Logout";
      
          return axios({
            method: "post",
            url: url,
            headers: _headers,
          })
            .then(function (response) {
              var result = response.data;
              resolve(result);
            })
            .catch(function (error) {
              resolve(null);
            });
        });
        */
    },


    GetRequestHeaders: async () => {

        var session = AuthBusiness.GetSessionFromLocalStorage();
        if (session == null) { return null; }

        var headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + session.accessToken
        };

        return headers;
    },

    GetSessionFromLocalStorage: () => {

        var encrypted = localStorage.getItem(Constants.Session.SessionObjectTitle);
        if (!IsNull(encrypted)) {
            try {

                var bytes = CryptoJS.AES.decrypt(encrypted, Constants.Session.Pk);
                var decryptedData = bytes.toString(CryptoJS.enc.Utf8);


                return JSON.parse(decryptedData);
            }
            catch (ex) {

                localStorage.removeItem(Constants.Session.SessionObjectTitle);
                return null;
            }
        }
        else {
            return null;
        }
    },

    /** Oturum bilgisinin local storage a atılmasını sağlar */
    SetSessionInLocalStorage: (_session) => {

        var json = JSON.stringify(_session);

        var encrypted = CryptoJS.AES.encrypt(json, Constants.Session.Pk);
        return localStorage.setItem(Constants.Session.SessionObjectTitle, encrypted);
    },


    HandleRejection: async (_res) => {

        return new Promise((resolve, reject) => {
            
            if (_res.response.status == 403) {
                localStorage.removeItem(Constants.Session.SessionObjectTitle);
                window.location("/");
            }
            reject({
                Type: Constants.MessageTypes.Error,
                Data: _res,
            });
        });

    }

};