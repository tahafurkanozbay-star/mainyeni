import axios from 'axios';
import { Constants } from '../Core/Constants';
import { Global } from '../Core/Global';

export interface AdminSession {
  readonly accessToken: string;
  readonly userName?: string;
  readonly [key: string]: unknown;
}

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

const clearStorageKey = (storage: Storage): void => {
  try {
    storage.removeItem(getSessionKey());
  } catch {
    // Storage can be unavailable in privacy-restricted contexts.
  }
};

const clearLegacySession = (): void => clearStorageKey(localStorage);

const clearSession = (): void => {
  clearStorageKey(sessionStorage);
  clearLegacySession();
};

const isAdminSession = (value: unknown): value is AdminSession => {
  if (typeof value !== 'object' || value === null) return false;
  const accessToken = (value as { accessToken?: unknown }).accessToken;
  return typeof accessToken === 'string' && accessToken.length > 0;
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

  // Historical method names remain for caller compatibility. Session data is
  // deliberately browser-session scoped and legacy persistent copies are purged.
  GetSessionFromLocalStorage: (): AdminSession | null => {
    clearLegacySession();
    try {
      const serialized = sessionStorage.getItem(getSessionKey());
      if (!serialized) return null;

      const session: unknown = JSON.parse(serialized);
      if (!isAdminSession(session)) {
        clearSession();
        return null;
      }
      return session;
    } catch {
      clearSession();
      return null;
    }
  },

  SetSessionInLocalStorage: (session: unknown): boolean => {
    clearLegacySession();
    if (!isAdminSession(session)) {
      clearSession();
      return false;
    }

    try {
      sessionStorage.setItem(getSessionKey(), JSON.stringify(session));
      return true;
    } catch {
      clearSession();
      return false;
    }
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
