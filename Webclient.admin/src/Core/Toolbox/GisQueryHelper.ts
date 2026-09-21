import React, { Component } from 'react';
import { loadModules } from "esri-loader";


export const GisQueryHelper = {

    //esri gis sorgu çalıştırma
    ExecuteQueryAsync: async (_options) => {

        return new Promise(resolve => {
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

                return queryTask.execute(query).then(function (result) {

                    let resultArray = result.features.map(x => {
                        return ({
                            attr: x.attributes,
                            geometry: x.geometry
                        });
                    });

                    resolve(resultArray);

                }, function (error) {

                    console.log(error);
                    resolve(null);
                });

            });

        });
    },

    ExecuteQuery: async (_options) => {


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

                return queryTask.execute(query).then(function (result) {

                    let resultArray = result.features.map(x => {
                        return ({
                            attr: x.attributes,
                            geometry: x.geometry
                        });
                    });


                    resolve(resultArray);

                }, function (error) {

                    console.log(error);
                    resolve(null);
                });



            });

        });
    },

    ExecuteSpatialQuery: async (_options) => {


        return new Promise((resolve, reject)=>{

            loadModules(["esri/tasks/QueryTask", "esri/tasks/support/Query"]).then(([QueryTask, Query]) => {

                // Represents the REST endpoint for a layer of cities.
                var queryTask = new QueryTask({
                    url: _options.url
                });
                var query = new Query(_options);
    
                return queryTask.execute(query).then(function (result) {
                    let resultArray = result.features.map(x => {
                        return ({
                            attr: x.attributes,
                            geometry: x.geometry
                        });
                    });
    
                    resolve(resultArray);
    
                }, function (error) {
                    console.log(error);
                    resolve(null);
                });
    
            });

        });
      
    }

}