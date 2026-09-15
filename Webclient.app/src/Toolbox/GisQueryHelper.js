import { loadModules } from "esri-loader";
import { Constants_ServiceResultType } from '../Core/Constants';

const toServiceResult = response => ({
    type: Constants_ServiceResultType.Success,
    data: response?.features?.map(feature => ({ attr: feature.attributes, geometry: feature.geometry })) || [],
    fields: response?.fields
});

const toErrorResult = error => ({ error, type: Constants_ServiceResultType.Error, data: null, fields: null });

export const GisQueryHelper = {
    ExecuteQuery: async options => {
        const [QueryTask, Query] = await loadModules(["esri/tasks/QueryTask", "esri/tasks/support/Query"]);
        const queryTask = new QueryTask({ url: options.url });
        const query = new Query();
        query.returnDistinctValues = options.returnDistinctValues || false;
        query.orderByFields = options.orderByFields || null;
        query.returnGeometry = options.returnGeometry || false;
        query.outFields = options.outFields;
        query.where = options.where || null;
        try {
            return toServiceResult(await queryTask.execute(query));
        } catch (error) {
            return toErrorResult(error);
        }
    },

    ExecuteSpatialQuery: async options => {
        const [QueryTask, Query] = await loadModules(["esri/tasks/QueryTask", "esri/tasks/support/Query"]);
        const queryTask = new QueryTask({ url: options.url });
        try {
            return toServiceResult(await queryTask.execute(new Query(options)));
        } catch (error) {
            return toErrorResult(error);
        }
    }
};
