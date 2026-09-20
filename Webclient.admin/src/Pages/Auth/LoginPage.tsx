import { useId, useState, type FormEvent } from "react";
import { Form } from "react-bootstrap";
import { MdOutlineApps } from "react-icons/md";
import { AuthBusiness } from "../../Business/AuthBusiness";
import { ButtonLoading } from "../../Components/Loading";
import { MessageToast, type ToastMessageType } from "../../Components/MessageToast";
import { Global } from "../../Core/Global";
import { safeErrorMessage } from "../../platform/contracts";
import { reportAdminError } from "../../platform/diagnostics";
import "./LoginPage.css";

interface LoginMessage {
  readonly text: string;
  readonly type: ToastMessageType;
}

export const LoginPage = () => {
  const usernameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoggingIn, setLoggingIn] = useState(false);
  const [message, setMessage] = useState<LoginMessage | null>(null);

  const showMessage = (text: string, type: ToastMessageType = "error"): void => {
    setMessage({ text, type });
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      showMessage("Lütfen kullanıcı adınızı giriniz.");
      return;
    }
    if (!password) {
      showMessage("Lütfen şifrenizi giriniz.");
      return;
    }

    setLoggingIn(true);
    setMessage(null);
    try {
      const result = await AuthBusiness.LoginUser(normalizedUsername, password);
      if (!result?.isSuccess || !AuthBusiness.SetSessionInLocalStorage(result.data)) {
        showMessage(result?.message ?? "Kullanıcı adı ya da şifre hatalı.");
        return;
      }
      window.location.reload();
    } catch (error) {
      reportAdminError("auth", "login-ui-failed", error);
      showMessage(safeErrorMessage(error, "Giriş sırasında beklenmeyen bir hata oluştu."));
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <main className="maincontainer">
      <div className="container-fluid">
        <div className="row no-gutter">
          <div className="col-md-8 d-none d-md-flex bg-image" aria-hidden="true" />
          <div className="col-md-4 LoginSection">
            <div className="login d-flex align-items-center py-5">
              <div className="container">
                {message ? (
                  <div className="row">
                    <div className="col-lg-12">
                      <MessageToast
                        dismissMessage={() => setMessage(null)}
                        message={message.text}
                        type={message.type}
                      />
                    </div>
                  </div>
                ) : null}

                <div className="row">
                  <div className="col-lg-10 col-xl-7 mx-auto">
                    <div className="row LoginHeader">
                      <div className="col-lg-12 align-self-center">
                        <MdOutlineApps aria-hidden="true" />
                        <h1 className="LoginTitle d-inline">
                          {Global.App.Title1}<strong>{Global.App.Title2}</strong>
                        </h1>
                      </div>
                    </div>

                    <Form onSubmit={(event) => { void submit(event); }} noValidate>
                      <Form.Group className="mb-3" controlId={usernameId}>
                        <Form.Label>Kullanıcı adı</Form.Label>
                        <Form.Control
                          type="text"
                          autoComplete="username"
                          placeholder="Kullanıcı adı ya da T.C. kimlik no"
                          value={username}
                          required
                          disabled={isLoggingIn}
                          onChange={(event) => setUsername(event.currentTarget.value)}
                        />
                      </Form.Group>

                      <Form.Group className="mb-3" controlId={passwordId}>
                        <Form.Label>Şifre</Form.Label>
                        <Form.Control
                          type="password"
                          autoComplete="current-password"
                          placeholder="Şifre"
                          value={password}
                          required
                          disabled={isLoggingIn}
                          onChange={(event) => setPassword(event.currentTarget.value)}
                        />
                      </Form.Group>

                      {isLoggingIn ? (
                        <ButtonLoading text="Giriş yapılıyor" />
                      ) : (
                        <button
                          type="submit"
                          className="btn btn-primary btn-block mb-2 shadow-sm float-end"
                        >
                          Giriş Yap
                        </button>
                      )}
                    </Form>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
