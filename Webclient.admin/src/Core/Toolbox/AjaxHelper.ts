import { Global } from '../Global';
import {
  adminApiGet,
  adminApiPost,
} from '../../runtime/adminApiClient';

const toEndpointPath = (url: string): string => {
  const base = Global.API_URL.replace(/\/+$/u, '');
  const candidate = String(url).trim();

  if (candidate.startsWith(base)) {
    const suffix = candidate.slice(base.length);
    return suffix.startsWith('/') ? suffix : `/${suffix}`;
  }

  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    return candidate;
  }

  throw new TypeError('AjaxHelper only accepts configured admin API URLs.');
};

export async function Get<T = unknown>(
  url: string,
): Promise<Readonly<{ data: T }>> {
  const data = await adminApiGet<T>(toEndpointPath(url));
  return Object.freeze({ data });
}

export async function Post<T = unknown>(
  url: string,
  data: unknown,
  _method?: string,
): Promise<Readonly<{ data: T }>> {
  const result = await adminApiPost<T>(toEndpointPath(url), data);
  return Object.freeze({ data: result });
}
