import type { AxiosRequestHeaders } from "axios";
import { Constants } from "../Core/Constants";
import { asAdminSession, asLoginResponse, type AdminSession, type LoginResponse } from "../platform/contracts";
import { authSessionStore } from "../platform/authSession";
import { adminHttpClient, normalizeRequestFailure } from "../platform/httpClient";
import { reportAdminError } from "../platform/diagnostics";

export interface LegacyRejection {
  readonly Type: number;
  readonly Data: unknown;
}

const redirectToLogin = (): void => {
  if (typeof window === "undefined") return;
  const next = new URL(window.location.href);
  next.hash = "#/";
  window.location.assign(next.toString());
};

export const AuthBusiness = Object.freeze({
  LoginUser: async (username: unknown, password: unknown): Promise<LoginResponse | null> => {
    const normalizedUser = typeof username === "string" ? username.trim() : "";
    const normalizedPassword = typeof password === "string" ? password : "";
    if (!normalizedUser || !normalizedPassword) return null;

    const data = new FormData();
    data.append("UserName", normalizedUser);
    data.append("Password", normalizedPassword);

    try {
      const response = await adminHttpClient.post<unknown>("/Auth/Login", data, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return asLoginResponse(response.data);
    } catch (error) {
      const failure = normalizeRequestFailure(error);
      if (failure.kind !== "unauthorized" && failure.kind !== "forbidden") {
        reportAdminError("auth", "login-failed", error, {
          kind: failure.kind,
          status: failure.status,
        });
      }
      return null;
    }
  },

  LogoutUser: (): void => {
    authSessionStore.clear("logout");
    if (typeof window !== "undefined") window.location.reload();
  },

  GetRequestHeaders: async (): Promise<AxiosRequestHeaders | null> => {
    const session = authSessionStore.read();
    if (!session?.accessToken) return null;
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    } as AxiosRequestHeaders;
  },

  GetSessionFromLocalStorage: (): AdminSession | null =>
    authSessionStore.read(),

  SetSessionInLocalStorage: (session: unknown): boolean =>
    authSessionStore.write(asAdminSession(session)),

  HandleRejection: async (reason: unknown): Promise<never> => {
    const failure = normalizeRequestFailure(reason);
    if (failure.status === 401 || failure.status === 403) {
      authSessionStore.clear(failure.status === 401 ? "expired" : "logout");
      redirectToLogin();
    }
    return Promise.reject(Object.freeze({
      Type: Constants.MessageTypes.Error,
      Data: reason,
    }) satisfies LegacyRejection);
  },
});
