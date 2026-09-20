import { AppConfig } from '../Core/AppConfig';
import { Constants_ServiceResultType } from '../Core/Constants';
import { AuthBusiness } from './AuthBusiness';
import { HttpBusiness } from './HttpBusiness';

export interface EgoBusinessFailure {
  readonly type: unknown;
  readonly message: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'Bilinmeyen hata');

const getEgoResource = async (path: string): Promise<unknown> => {
  const headers = await AuthBusiness.GetRequestHeaders();

  try {
    return await HttpBusiness.Get(AppConfig.Api.BaseUrl + path, { headers });
  } catch (error) {
    throw Object.freeze<EgoBusinessFailure>({
      type: Constants_ServiceResultType.Error,
      message: errorMessage(error),
    });
  }
};

export const EgoQueryBusiness = Object.freeze({
  GetActiveLines: (): Promise<unknown> => getEgoResource('/Ego/ActiveLines'),
  GetActiveStops: (): Promise<unknown> => getEgoResource('/Ego/ActiveStops'),
  GetLineInfo: (lineNo: unknown): Promise<unknown> =>
    getEgoResource('/Ego/LineInfo/' + encodeURIComponent(String(lineNo ?? ''))),
});
