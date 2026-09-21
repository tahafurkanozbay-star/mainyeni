import { Constants } from '../Core/Constants';
import {
  adminApiPostForm,
  type AdminApiError,
} from '../runtime/adminApiClient';
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

const sanitizedFailure = (error: unknown): Readonly<Record<string, unknown>> => {
  const candidate = error as Partial<AdminApiError> | null;
  return Object.freeze({
    code: typeof candidate?.code === 'string' ? candidate.code : 'unknown',
    status: typeof candidate?.status === 'number' ? candidate.status : null,
  });
};

export const AuthBusiness = {
  LoginUser: async (
    username: string,
    password: string,
  ): Promise<AdminLoginResult | null> => {
    const data = new FormData();
    data.append('UserName', username);
    data.append('Password', password);

    try {
      return await adminApiPostForm<AdminLoginResult>(
        '/Auth/Login',
        data,
        {
          authenticated: false,
          redirectOnUnauthorized: false,
        },
      );
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

  GetSessionFromLocalStorage: (): AdminSession | null => readAdminSession(),

  SetSessionInLocalStorage: (session: unknown): boolean =>
    writeAdminSession(session),

  HandleRejection: async (error: unknown): Promise<never> =>
    Promise.reject({
      Type: Constants.MessageTypes.Error,
      Data: sanitizedFailure(error),
    }),
};
