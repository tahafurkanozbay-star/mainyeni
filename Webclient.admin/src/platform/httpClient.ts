import axios, {
  AxiosError,
  AxiosHeaders,
  isAxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { authSessionStore, type AuthSessionStore } from "./authSession";
import { isRecord, readString, safeErrorMessage, type RequestFailure } from "./contracts";
import { reportAdminError } from "./diagnostics";
import { runtimeConfig } from "./runtimeConfig";

export interface AdminHttpClientOptions {
  readonly baseURL?: string;
  readonly timeoutMs?: number;
  readonly sessionStore?: AuthSessionStore;
  readonly onAuthFailure?: (status: 401 | 403) => void;
}

const responseMessage = (error: AxiosError): string | null => {
  const data = error.response?.data;
  if (!isRecord(data)) return null;
  return readString(data.message ?? data.Message ?? data.error ?? data.title);
};

export const normalizeRequestFailure = (error: unknown): RequestFailure => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return Object.freeze({
      kind: "aborted",
      status: null,
      message: "İstek iptal edildi.",
      retriable: false,
      cause: error,
    });
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return Object.freeze({
      kind: "timeout",
      status: null,
      message: "İstek zaman aşımına uğradı.",
      retriable: true,
      cause: error,
    });
  }
  if (!isAxiosError(error)) {
    return Object.freeze({
      kind: "unknown",
      status: null,
      message: safeErrorMessage(error),
      retriable: false,
      cause: error,
    });
  }

  const status = error.response?.status ?? null;
  if (error.code === AxiosError.ERR_CANCELED) {
    return Object.freeze({
      kind: "aborted",
      status,
      message: "İstek iptal edildi.",
      retriable: false,
      cause: error,
    });
  }
  if (error.code === AxiosError.ECONNABORTED || error.code === AxiosError.ETIMEDOUT) {
    return Object.freeze({
      kind: "timeout",
      status,
      message: "İstek zaman aşımına uğradı.",
      retriable: true,
      cause: error,
    });
  }
  if (status === 401) {
    return Object.freeze({
      kind: "unauthorized",
      status,
      message: "Oturum geçersiz veya süresi dolmuş.",
      retriable: false,
      cause: error,
    });
  }
  if (status === 403) {
    return Object.freeze({
      kind: "forbidden",
      status,
      message: "Bu işlem için yetkiniz bulunmuyor.",
      retriable: false,
      cause: error,
    });
  }
  if (status !== null) {
    return Object.freeze({
      kind: "http",
      status,
      message: responseMessage(error) ?? `HTTP ${status} hatası.`,
      retriable: status === 408 || status === 425 || status === 429 || status >= 500,
      cause: error,
    });
  }
  if (error.request) {
    return Object.freeze({
      kind: "network",
      status: null,
      message: "Sunucuya ulaşılamadı.",
      retriable: true,
      cause: error,
    });
  }
  return Object.freeze({
    kind: "unknown",
    status: null,
    message: safeErrorMessage(error),
    retriable: false,
    cause: error,
  });
};

const requestHeaders = (config: InternalAxiosRequestConfig, store: AuthSessionStore): AxiosHeaders => {
  const headers = AxiosHeaders.from(config.headers);
  headers.set("Accept", "application/json");
  const session = store.read();
  if (session?.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);
  else headers.delete("Authorization");
  return headers;
};

export const createAdminHttpClient = (options: AdminHttpClientOptions = {}): AxiosInstance => {
  const store = options.sessionStore ?? authSessionStore;
  const instance = axios.create({
    baseURL: options.baseURL ?? runtimeConfig.apiBaseUrl,
    timeout: options.timeoutMs ?? runtimeConfig.requestTimeoutMs,
    headers: { Accept: "application/json" },
  });

  instance.interceptors.request.use((config) => {
    config.headers = requestHeaders(config, store);
    return config;
  });

  instance.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      const failure = normalizeRequestFailure(error);
      if (failure.status === 401 || failure.status === 403) {
        store.clear(failure.status === 401 ? "expired" : "logout");
        try {
          options.onAuthFailure?.(failure.status);
        } catch (observerError) {
          reportAdminError("auth", "auth-failure-observer", observerError);
        }
      } else if (failure.kind !== "aborted") {
        reportAdminError("http", "request-failed", error, {
          kind: failure.kind,
          status: failure.status,
          retriable: failure.retriable,
        });
      }
      return Promise.reject(failure);
    },
  );

  return instance;
};

export const adminHttpClient = createAdminHttpClient();

export const getJson = async <T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> => adminHttpClient.get<T>(url, config);

export const postJson = async <TResponse, TBody = unknown>(
  url: string,
  body: TBody,
  config?: AxiosRequestConfig<TBody>,
): Promise<AxiosResponse<TResponse>> => adminHttpClient.post<TResponse>(url, body, config);
