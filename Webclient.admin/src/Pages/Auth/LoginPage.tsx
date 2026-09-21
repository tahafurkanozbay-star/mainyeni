import { type FormEvent, useState } from 'react';
import { Form } from 'react-bootstrap';
import { MdOutlineApps } from 'react-icons/md';

import { AuthBusiness } from '../../Business/AuthBusiness';
import { ButtonLoading } from '../../Components/Loading';
import { MessageToast } from '../../Components/MessageToast';
import { Global } from '../../Core/Global';
import './LoginPage.css';

export const LoginPage = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setLoggingIn] = useState(false);
  const [currentMessage, setCurrentMessage] = useState<string | null>(null);
  const [currentMessageType, setCurrentMessageType] = useState<string | null>(null);

  const showMessage = (message: string, type: string): void => {
    setCurrentMessage(message);
    setCurrentMessageType(type);
  };

  const dismissMessage = (): void => {
    setCurrentMessage(null);
    setCurrentMessageType(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!username.trim()) {
      showMessage('Lütfen kullanıcı adınızı giriniz', 'error');
      return;
    }
    if (!password) {
      showMessage('Lütfen şifrenizi giriniz', 'error');
      return;
    }

    setLoggingIn(true);
    const authResult = await AuthBusiness.LoginUser(username.trim(), password);
    if (authResult?.isSuccess && authResult.data && AuthBusiness.SetSessionInLocalStorage(authResult.data)) {
      window.location.reload();
      return;
    }

    setLoggingIn(false);
    showMessage('Kullanıcı adı ya da şifre hatalı', 'error');
  };

  return (
    <div className="maincontainer">
      <div className="container-fluid">
        <div className="row no-gutter">
          <div className="col-md-8 d-none d-md-flex bg-image" aria-hidden="true" />
          <div className="col-md-4 LoginSection">
            <div className="login d-flex align-items-center py-5">
              <div className="container">
                <div className="row">
                  <div className="col-lg-12" aria-live="polite">
                    {currentMessage !== null ? (
                      <MessageToast
                        dismissMessage={dismissMessage}
                        message={currentMessage}
                        type={currentMessageType}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="row">
                  <div className="col-lg-10 col-xl-7 mx-auto">
                    <div className="row LoginHeader">
                      <div className="col-lg-12 align-self-center">
                        <MdOutlineApps aria-hidden="true" />
                        <span className="LoginTitle">
                          {Global.App.Title1}<strong>{Global.App.Title2}</strong>
                        </span>
                      </div>
                    </div>
                    <Form onSubmit={submit}>
                      <div className="form-group mb-3">
                        <label className="visually-hidden" htmlFor="admin-username">Kullanıcı adı</label>
                        <input
                          id="admin-username"
                          type="text"
                          autoComplete="username"
                          placeholder="kullanıcı adı ya da tc kimlik no giriniz"
                          required
                          className="form-control border-0 shadow-sm px-4"
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                        />
                      </div>
                      <div className="form-group mb-3">
                        <label className="visually-hidden" htmlFor="admin-password">Şifre</label>
                        <input
                          id="admin-password"
                          type="password"
                          autoComplete="current-password"
                          placeholder="Şifre"
                          required
                          className="form-control border-0 shadow-sm px-4 text-primary"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </div>
                      {isLoggingIn ? ButtonLoading() : (
                        <button
                          type="submit"
                          className="btn btn-primary mb-2 shadow-sm float-end"
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
    </div>
  );
};
