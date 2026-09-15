import { loadModules } from "esri-loader";
import { Constants_ServiceResultType } from "../Core/Constants";

const toServiceResult = (_response) => ({
    type: Constants_ServiceResultType.Success,
    data: (_response?.features ?? []).map((feature) => ({
        attr: feature.attributes,
        geometry: feature.geometry
    })),
    fields: _response?.fields ?? []
});

const toErrorResult = (error) => ({
    error,
    type: Constants_ServiceResultType.Error,
    data: null,
    fields: null
});

const executeQuery = async (options, useOptionsConstructor = false) => {
    try {
        const [QueryTask, Query] = await loadModules([
            "esri/tasks/QueryTask",
            "esri/tasks/support/Query"
        ]);

        const queryTask = new QueryTask({ url: options.url });
        const query = useOptionsConstructor ? new Query(options) : new Query();

        if (!useOptionsConstructor) {
            query.returnDistinctValues = Boolean(options.returnDistinctValues);
            query.orderByFields = options.orderByFields ?? null;
            query.returnGeometry = Boolean(options.returnGeometry);
            query.outFields = options.outFields ?? ["*"];
            query.where = options.where ?? "1=1";
        }

        return toServiceResult(await queryTask.execute(query));
    } catch (error) {
        return toErrorResult(error);
    }
};

export const GisQueryHelper = {
    ExecuteQuery: async (options) => executeQuery(options, false),
    ExecuteSpatialQuery: async (options) => executeQuery(options, true)
};
