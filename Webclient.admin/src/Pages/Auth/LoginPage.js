import { useState } from "react";
import { AuthBusiness } from "../../Business/AuthBusiness";
import { IsNull } from "../../Core/Toolbox/ObjectHelper";
import { Constants } from "../../Core/Constants";
import { Form } from "react-bootstrap";
import { ButtonLoading } from "../../Components/Loading";
import { MessageToast } from "../../Components/MessageToast";
import { MdOutlineApps } from "react-icons/md";
import "./LoginPage.css";
import { Global } from "../../Core/Global";

export const LoginPage = () => {

    const [username, setUserName] = useState();
    const userName_OnChange = (e) => {
        setUserName(e.target.value);
    }

    const [password, setPassword] = useState();
    const password_OnChange = (e) => {
        setPassword(e.target.value);
    }

    const [isLoggingIn, setLoggingIn] = useState(false);


    const validate = () => {

        let validated = true;
        if (IsNull(username)) {
            showMessage("Lütfen kullanıcı adınızı giriniz", "error");
            validated = false;
        }
        else if (IsNull(password)) {
            showMessage("Lütfen şifrenizi giriniz", "error");
            validated = false;
        }
        return validated;
    }

    const submit = async (e) => {

        if (validate()) {

            setLoggingIn(true);

            let authResult = await AuthBusiness.LoginUser(username, password);
            if (authResult != null && authResult.isSuccess) {

                AuthBusiness.SetSessionInLocalStorage(authResult.data);
                window.location.href=process.env.PUBLIC_URL+"/";
            }
            else {
                setLoggingIn(false);
                showMessage("Kullanıcı adı ya da şifre hatalı", "error");
            }
        }

    }

    const [currentMessage, setcurrentMessage] = useState();
    const [currentMessageType, setCurrentMessageType] = useState();
    const showMessage = (_message, _type) => {
        setcurrentMessage(_message);
        setCurrentMessageType(_type);
    }

    //Gösterilen notification message kapatılır
    const dismissMessage = () => {
        setcurrentMessage(null);
        setCurrentMessageType(null);
    }

    const form_OnSubmit = (e) => {
        e.preventDefault();
        submit();
    }

    return (
        <div className="maincontainer">
            <div className="container-fluid">

                <div className="row no-gutter">
                    <div className="col-md-8 d-none d-md-flex bg-image">
                    </div>
                    <div className="col-md-4 LoginSection">

                        <div className="login d-flex align-items-center py-5">
                            <div className="container">
                                <div className="row">
                                    <div className="col-lg-12">
                                        {
                                            currentMessage != null ?

                                                <MessageToast
                                                    dismissMessage={dismissMessage}
                                                    message={currentMessage}
                                                    type={currentMessageType}></MessageToast> : null
                                        }
                                    </div>
                                </div>
                                <p></p>
                                <p></p>
                                <div className="row">
                                    <div className="col-lg-10 col-xl-7 mx-auto">
                                        <div className="row LoginHeader">
                                            <div className="col-lg-12 align-self-center">
                                                <MdOutlineApps></MdOutlineApps>
                                                <span className="LoginTitle">{Global.App.Title1}<strong>{Global.App.Title2}</strong></span>
                                            </div>
                                        </div>
                                        <Form onSubmit={(e) => form_OnSubmit(e)}>
                                            <div className="form-group mb-3">
                                                <input id="inputEmail" type="email" placeholder="kullanıcı adı ya da tc kimlik no giriniz"
                                                    required="" className="form-control border-0 shadow-sm px-4"
                                                    onChange={(e) => { userName_OnChange(e) }} />
                                            </div>
                                            <div className="form-group mb-3">
                                                <input id="inputPassword"
                                                    type="password" placeholder="Şifre" required=""
                                                    className="form-control  border-0 shadow-sm px-4 text-primary"
                                                    onChange={(e) => { password_OnChange(e) }} />
                                            </div>
                                            {
                                                isLoggingIn ? ButtonLoading() :
                                                    <button type="submit" className="btn btn-primary btn-block mb-2 shadow-sm float-end"
                                                        onClick={(e) => { submit(e) }}>Giriş Yap</button>
                                            }
                                        </Form>
                                    </div>
                                </div>

                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )


}