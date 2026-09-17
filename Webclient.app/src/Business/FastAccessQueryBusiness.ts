import { Constants_ServiceResultType } from '../Core/Constants';
import type { FastAccessQuery, QueryExecutionControl } from './contracts';
import { BusinessContractError } from './contracts';
import { fastAccessRuntime, queryFastAccessService } from './fastAccessRuntime';

const preserveLegacyErrorContract = (error: unknown): never => {
  if (error instanceof BusinessContractError) {
    Object.assign(error, {
      type: Constants_ServiceResultType.Error,
      message: error.message,
    });
  }
  throw error;
};

export const FastAccessQueryBusiness = Object.freeze({
  QueryFastAccessService: async (
    queryServiceTitle: string,
    query: FastAccessQuery = {},
    returnGeometry = false,
    control: QueryExecutionControl = {},
  ): Promise<unknown> => {
    try {
      return await queryFastAccessService(
        queryServiceTitle,
        query,
        Boolean(returnGeometry),
        control,
      );
    } catch (error) {
      return preserveLegacyErrorContract(error);
    }
  },

  ClearCache: (serviceKey?: string): number => fastAccessRuntime.clearCache(serviceKey),
  CancelQueued: (serviceKey?: string): number => fastAccessRuntime.cancelQueued(
    serviceKey ? (candidate) => candidate === serviceKey : undefined,
  ),
  Snapshot: () => fastAccessRuntime.snapshot(),
});
