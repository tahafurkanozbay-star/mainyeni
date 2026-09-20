import { AppConfig } from '../Core/AppConfig';
import { Constants_ServiceResultType } from '../Core/Constants';
import { AuthBusiness } from './AuthBusiness';
import { HttpBusiness } from './HttpBusiness';

export interface EgoBusinessFailure {
  readonly type: unknown;
  readonly message: string;
}

export interface EgoServiceResult {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly message?: unknown;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'Bilinmeyen hata');

const getEgoResource = async (path: string): Promise<EgoServiceResult> => {
  const headers = await AuthBusiness.GetRequestHeaders();

  try {
    return await HttpBusiness.Get<EgoServiceResult>(AppConfig.Api.BaseUrl + path, { headers });
  } catch (error) {
    throw Object.freeze<EgoBusinessFailure>({
      type: Constants_ServiceResultType.Error,
      message: errorMessage(error),
    });
  }
};

export const EgoQueryBusiness = Object.freeze({
  GetActiveLines: (): Promise<EgoServiceResult> => getEgoResource('/Ego/ActiveLines'),
  GetActiveStops: (): Promise<EgoServiceResult> => getEgoResource('/Ego/ActiveStops'),
  GetLineInfo: (lineNo: unknown): Promise<EgoServiceResult> =>
    getEgoResource('/Ego/LineInfo/' + encodeURIComponent(String(lineNo ?? ''))),
});
