import { FastAccessQueryBusiness } from "./FastAccessQueryBusiness";

export const createFastAccessQueryBusiness = serviceKey => Object.freeze({
    Query: (query, returnGeometry) => FastAccessQueryBusiness.QueryFastAccessService(
        serviceKey,
        query,
        returnGeometry
    )
});
