import { arcgisToGeoJSON } from '@terraformer/arcgis';
import * as FileSaver from 'file-saver';
import { loadModules } from 'esri-loader';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import * as XLSX from 'xlsx';

import { exportFont } from '../Fonts/UbuntuNormal';
import { createKmlDocument, type DataRecord, type GeoJsonGeometry } from '../../runtime/kmlSerializer';

const triggerTextDownload = (content: string, filename: string, mimeType: string): void => {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  try {
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
};

export const DataHelper = {
  ExportJsonToCsv: async (
    json: readonly DataRecord[],
    fields: readonly string[],
    filename: string,
  ): Promise<void> => {
    const replacer = (_key: string, value: unknown): unknown => value === null ? '' : value;
    const rows = json.map((row) =>
      fields.map((fieldName) => JSON.stringify(row[fieldName], replacer)).join(','),
    );
    rows.unshift(fields.join(','));
    triggerTextDownload(
      `\uFEFF${rows.join('\r\n')}`,
      filename,
      'text/csv;charset=utf-8',
    );
  },

  ExportJsonToExcel: async (
    json: readonly DataRecord[],
    fields: readonly string[],
    filename: string,
  ): Promise<void> => {
    const resultData = json.map((item) =>
      Object.fromEntries(fields.map((field) => [field, item[field]])),
    );

    const fileType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8';
    const worksheet = XLSX.utils.json_to_sheet(resultData);
    const workbook = { Sheets: { data: worksheet }, SheetNames: ['data'] };
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    FileSaver.saveAs(new Blob([excelBuffer], { type: fileType }), `${filename}.xlsx`);
  },

  ExportJsonToPdf: async (
    json: readonly DataRecord[],
    fields: readonly string[],
    filename: string,
  ): Promise<void> => {
    const rows = json.map((item) => fields.map((field) => item[field] ?? ''));
    exportFont();

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [697, 210] });
    doc.setFont('Ubuntu', 'normal');
    autoTable(doc, {
      head: [[...fields]],
      body: rows,
      styles: { font: 'Ubuntu' },
      theme: 'grid',
      tableWidth: 'auto',
    });
    doc.save(`${filename}.pdf`);
  },

  ExportGeometriesToKML: async (
    geometries: readonly unknown[] | null | undefined,
    attributes?: readonly DataRecord[] | null,
  ): Promise<readonly GeoJsonGeometry[] | null> => {
    if (!geometries || geometries.length === 0) return null;

    const [projection, SpatialReference] = await loadModules([
      'esri/geometry/projection',
      'esri/geometry/SpatialReference',
    ]);

    await projection.load?.();

    const outSpatialReference = new SpatialReference({ wkid: 4326 });
    const projected = projection.project(geometries, outSpatialReference);
    const projectedList = Array.isArray(projected) ? projected : [projected];

    const geoJsonList = projectedList
      .filter(Boolean)
      .map((geometry) => arcgisToGeoJSON(geometry) as GeoJsonGeometry);

    const kml = createKmlDocument(geoJsonList, attributes ?? []);
    triggerTextDownload(kml, 'export.kml', 'application/vnd.google-earth.kml+xml;charset=utf-8');
    return geoJsonList;
  },
};
