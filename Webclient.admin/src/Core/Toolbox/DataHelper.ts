import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { exportFont } from "../Fonts/UbuntuNormal";

import * as FileSaver from 'file-saver';
import * as XLSX from 'xlsx';
import { loadModules } from 'esri-loader';

import { xml2js, xml2json, json2xml, js2xml } from "xml-js";
import { arcgisToGeoJSON } from "@terraformer/arcgis";
import tokml from "tokml";

export const DataHelper = {

    ExportJsonToCsv: async (json, fields, filename) => {

        var replacer = function (key, value) { return value === null ? '' : value }
        var csv = json.map(function (row) {
            return fields.map(function (fieldName) {
                return JSON.stringify(row[fieldName], replacer)
            }).join(',')
        })
        csv.unshift(fields.join(',')) // add header column
        csv = csv.join('\r\n');

        // Create link and download
        var link = document.createElement('a');
        link.setAttribute('href', 'data:text/csv;charset=utf-8,%EF%BB%BF' + encodeURIComponent(csv));
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

    }


    , ExportJsonToExcel: async (json, fields, filename) => {

        var resultData = [];

        json.forEach(item => {

            var resultItem = {};
            fields.forEach(field => {
                resultItem[field] = item[field];
            });

            resultData.push(resultItem);
        });

        const fileType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8';
        const fileExtension = '.xlsx';
        const ws = XLSX.utils.json_to_sheet(resultData);
        const wb = { Sheets: { 'data': ws }, SheetNames: ['data'] };
        const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const data = new Blob([excelBuffer], { type: fileType });
        FileSaver.saveAs(data, filename + fileExtension);
    }


    , ExportJsonToPdf: async (json, fields, filename) => {

        var rows = [];

        json.forEach(element => {

            let valuesRow = [];

            fields.forEach(field => {
                valuesRow.push(element[field]);
            });

            rows.push(valuesRow);
        });

        exportFont();
        var doc = new jsPDF('l', 'mm', [697, 210]);

        doc.setFont('Ubuntu', 'normal'); // set custom font
        doc.autoTable({
            head: [fields],
            body: rows,
            styles: { font: "Ubuntu" },
            theme: 'grid',
            tableWidth: 'auto',
            columnWidth: 'wrap',
        });

        doc.save(filename + ".pdf");
    }





    , ExportGeometriesToKML: async (_geometries, _attributes) => {

        return new Promise((resolve) => {
            var geoJsonList = [];

            if (_geometries != null) {

                loadModules(["esri/geometry/projection", "esri/geometry/SpatialReference"]).then(([projection, SpatialReference]) => {

                    let outSpatialReference = new SpatialReference({
                        wkid: 4326
                    });

                    let _projectedGeometryList = projection.project(_geometries, outSpatialReference);

                    let index = 0;
                    _projectedGeometryList.forEach((_geom) => {

                        let geoJsonObj = arcgisToGeoJSON(_geom);
                        geoJsonList.push({
                            type: "Feature",
                            properties: _attributes != null ? _attributes[index] : {},
                            geometry: geoJsonObj
                        });

                        index++;

                    });


                    var featureCollection = {
                        type: "FeatureCollection",
                        features: geoJsonList
                    };

                    var kml = tokml(featureCollection);

                    var result1 = xml2js(kml, { compact: true, spaces: 4 });

                    result1.kml.Document.Style = {
                        "_attributes": {
                            "id": "polygon-style"
                        },
                        "PolyStyle": {
                            "color": "FF0000FF",
                            "fill": 0,
                            "outline": 1,
                        },
                        "LineStyle": {
                            "color": "FF0000AA",
                            "width": "3"
                        }
                    };

                    if (Array.isArray(result1.kml.Document.Placemark)) {
                        result1.kml.Document.Placemark.forEach((_placemark) => {
                            _placemark.styleUrl = "polygon-style";
                        });
                    }

                    var styledkml = js2xml(result1, { compact: true, spaces: 4 });

                    // Create link and download
                    var link = document.createElement('a');
                    link.setAttribute('href', 'data:text/xml;charset=utf-8,%EF%BB%BF' + encodeURIComponent(styledkml));
                    link.setAttribute('download', "export.kml");
                    link.style.visibility = 'hidden';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    resolve(geoJsonList);


                });


            }
            else {
                resolve(null);
            }

        });
    }


}

