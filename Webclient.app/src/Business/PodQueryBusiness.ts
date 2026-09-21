import { AppConfig } from '../Core/AppConfig';
import { isRecord } from './contracts';
import type { FastAccessQuery } from './contracts';
import { AuthBusiness } from './AuthBusiness';
import { FastAccessQueryBusiness } from './FastAccessQueryBusiness';
import { HttpBusiness } from './HttpBusiness';

export interface PodDutyQuery {
  readonly name?: string | null;
}

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '').trim().toLocaleLowerCase('tr-TR');

export const PodQueryBusiness = Object.freeze({
  Query: (
    query: FastAccessQuery = {},
    returnGeometry = false,
  ): Promise<unknown> =>
    FastAccessQueryBusiness.QueryFastAccessService(
      'PharmacyQueryUrl',
      query,
      returnGeometry,
    ),

  QueryPodOnDuty: async (query: PodDutyQuery = {}): Promise<Readonly<Record<string, unknown>>> => {
    const headers = await AuthBusiness.GetRequestHeaders();
    const response = await HttpBusiness.Get<unknown>(
      AppConfig.Api.BaseUrl + '/Pod/List/',
      { headers },
    );
    const root = isRecord(response) ? response : {};
    const records = Array.isArray(root.data) ? root.data.filter(isRecord) : [];
    const name = normalizeSearchText(query.name);
    const data = name
      ? records.filter((item) => normalizeSearchText(item.title).includes(name))
      : records;

    return Object.freeze({
      ...root,
      data: Object.freeze(data),
    });
  },
});
