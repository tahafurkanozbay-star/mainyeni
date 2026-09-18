import { Constants_MessageType } from '../Core/Constants';

export interface AuthenticationRejection<TValue = unknown> {
  readonly Type: unknown;
  readonly Data: TValue;
}

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

export const AuthBusiness = Object.freeze({
  // Public map endpoints are intentionally anonymous on the server. A browser-generated
  // bearer value derived from a bundled key is not authentication and only creates a false
  // security boundary, so callers receive ordinary JSON headers instead.
  GetRequestHeaders: async (): Promise<Readonly<Record<string, string>>> => JSON_HEADERS,

  HandleRejection: async <TValue>(response: TValue): Promise<never> => Promise.reject(
    Object.freeze({
      Type: Constants_MessageType.Error,
      Data: response,
    }) satisfies AuthenticationRejection<TValue>,
  ),
});
