import React, { Component } from 'react';
import { loadModules } from "esri-loader";
import { Constants_ServiceResultType } from '../Core/Constants';
import { DebugHelper } from './DebugHelper';

export const GisQueryHelper = {

    ExecuteQuery: async (_options) => {

        //DebugHelper.Log("[GIS-QUERY] querying - " + _options.url);

        return new Promise((resolve, reject) => {

            loadModules(["esri/tasks/QueryTask", "esri/tasks/support/Query"]).then(([QueryTask, Query]) => {

                // Represents the REST endpoint for a layer of cities.
                var queryTask = new QueryTask({
                    url: _options.url
                });
                var query = new Query();
                query.returnDistinctValues = _options.returnDistinctValues || false;
                query.orderByFields = _options.orderByFields || null;
                query.returnGeometry = _options.returnGeometry || false;
                query.outFields = _options.outFields; //["*"];
                query.where = _options.where || null;//"1=1";  

                return queryTask.execute(query).then(function (_response) {

                    let response = {};
                    let resultArray = _response?.features.map(x => {
                        return ({
                            attr: x.attributes,
                            geometry: x.geometry
                        });
                    });
                    response.type = Constants_ServiceResultType.Success;
                    response.data = resultArray;
                    response.fields = _response.fields;

                    //DebugHelper.Log("[GIS-QUERY] response - " + _options.url);
                    //DebugHelper.Log(response);
                    resolve(response);

                }, function (error) {
                    let response = {
                        error,
                        type: Constants_ServiceResultType.Error,
                        data: null,
                        fields: null
                    };
                    
                    //DebugHelper.Log("[GIS-QUERY] response error - " + _options.url);
                    //DebugHelper.Log(response);

                    resolve(response);
                });



            });

        });
    },

    ExecuteSpatialQuery: async (_options) => {
        return new Promise((resolve, reject) => {

            loadModules(["esri/tasks/QueryTask", "esri/tasks/support/Query"]).then(([QueryTask, Query]) => {

                // Represents the REST endpoint for a layer of cities.
                var queryTask = new QueryTask({
                    url: _options.url
                });
                var query = new Query(_options);

                return queryTask.execute(query).then(function (_response) {

                    let response = {};
                    let resultArray = _response?.features.map(x => {
                        return ({
                            attr: x.attributes,
                            geometry: x.geometry
                        });
                    });
                    response.type = Constants_ServiceResultType.Success;
                    response.data = resultArray;
                    response.fields = _response.fields;

                    //DebugHelper.Log("[GIS-QUERY] response - " + _options.url);
                    //DebugHelper.Log(response);
                    resolve(response);

                }, function (error) {

                    let response = {
                        error,
                        type: Constants_ServiceResultType.Error,
                        data: null,
                        fields: null
                    };
                    //DebugHelper.Log("[GIS-QUERY] response error - " + _options.url);
                    //DebugHelper.Log(response);

                    resolve(response);
                });

            });

        });

    }
}