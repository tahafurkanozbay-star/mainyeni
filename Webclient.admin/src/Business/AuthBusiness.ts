import axios from 'axios';
import { Constants } from '../Core/Constants';
import { Global } from '../Core/Global';

import { isValidAdminSession, type ValidAdminSession } from './AdminSessionValidation';
import { purgeLegacyAdminStorage } from './AdminLegacyStorageCleanup';

export type AdminSession = ValidAdminSession;

export interface AdminLoginResult {
  readonly isSuccess: boolean;
  readonly data?: AdminSession;
  readonly message?: string;
}

interface AxiosLikeError {
  readonly response?: {
    readonly status?: number;
  };
}

const getSessionKey = (): string => Constants.Session.SessionObjectTitle;

// Bearer material is held only in this module's volatile memory. A reload
// ends the Admin login rather than allowing arbitrary same-origin scripts to
// recover the token from Web Storage.
let activeSession: AdminSession | null = null;

const clearSession = (): void => {
  activeSession = null;
  purgeLegacyAdminStorage(getSessionKey());
};

export const AuthBusiness = {
  LoginUser: async (username: string, password: string): Promise<AdminLoginResult | null> => {
    try {
      const data = new FormData();
      data.append('UserName', username);
      data.append('Password', password);

      const response = await axios.post<AdminLoginResult>(
        `${Global.API_URL}/Auth/Login`,
        data,
        {
          timeout: 15_000,
          headers: { Accept: 'application/json' },
        },
      );
      return response.data;
    } catch {
      return null;
    }
  },

  LogoutUser: (): void => {
    clearSession();
    window.location.reload();
  },

  GetRequestHeaders: async (): Promise<Readonly<Record<string, string>> | null> => {
    const session = AuthBusiness.GetSessionFromLocalStorage();
    if (!session) return null;

    return Object.freeze({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
    });
  },

  // Preserve the public method names for existing callers, but never
  // serialize a bearer token into any browser-persistent store.
  GetSessionFromLocalStorage: (): AdminSession | null => {
    purgeLegacyAdminStorage(getSessionKey());
    if (activeSession !== null && !isValidAdminSession(activeSession)) {
      activeSession = null;
    }
    return activeSession;
  },

  SetSessionInLocalStorage: (session: unknown): boolean => {
    purgeLegacyAdminStorage(getSessionKey());
    if (!isValidAdminSession(session)) {
      clearSession();
      return false;
    }
    // Only approved fields survive a login response. Do not keep arbitrary
    // API payload objects, secrets or callbacks in the active session.
    activeSession = Object.freeze({
      accessToken: session.accessToken,
      ...(session.userName === undefined ? {} : { userName: session.userName }),
    });
    return true;
  },

  HandleRejection: async (error: AxiosLikeError): Promise<never> => {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      clearSession();
      window.location.assign('./');
    }

    return Promise.reject({
      Type: Constants.MessageTypes.Error,
      Data: error,
    });
  },
};
