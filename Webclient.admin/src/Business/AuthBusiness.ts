import axios from 'axios';
import { Constants } from '../Core/Constants';
import { Global } from '../Core/Global';
import {
  clearAdminSession,
  readAdminSession,
  writeAdminSession,
  type AdminSession,
} from '../runtime/adminSession';

export type { AdminSession } from '../runtime/adminSession';

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

export const AuthBusiness = {
  LoginUser: async (
    username: string,
    password: string,
  ): Promise<AdminLoginResult | null> => {
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
    clearAdminSession();
    window.location.reload();
  },

  GetRequestHeaders: async (): Promise<Readonly<Record<string, string>> | null> => {
    const session = readAdminSession();
    if (!session) return null;

    return Object.freeze({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
    });
  },

  // Historical names are preserved for caller compatibility while the storage
  // implementation lives in the lightweight runtime module.
  GetSessionFromLocalStorage: (): AdminSession | null => readAdminSession(),

  SetSessionInLocalStorage: (session: unknown): boolean =>
    writeAdminSession(session),

  HandleRejection: async (error: AxiosLikeError): Promise<never> => {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      clearAdminSession();
      window.location.assign('./');
    }

    return Promise.reject({
      Type: Constants.MessageTypes.Error,
      Data: error,
    });
  },
};
