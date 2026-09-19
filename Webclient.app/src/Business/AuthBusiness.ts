import { Constants_MessageType } from '../Core/Constants';

export type RequestHeaders = Readonly<Record<string, string>>;

export interface LegacyBusinessRejection {
  readonly Type: unknown;
  readonly Data: unknown;
}

const REQUEST_HEADERS: RequestHeaders = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

export const AuthBusiness = Object.freeze({
  // Public map endpoints are intentionally anonymous on the server. A browser-generated
  // bearer value derived from a bundled key is not authentication and only creates a false
  // security boundary, so callers receive ordinary JSON headers instead.
  GetRequestHeaders: async (): Promise<RequestHeaders> => REQUEST_HEADERS,

  HandleRejection: async <TResult = never>(response: unknown): Promise<TResult> =>
    Promise.reject(Object.freeze<LegacyBusinessRejection>({
      Type: Constants_MessageType.Error,
      Data: response,
    })),
});
