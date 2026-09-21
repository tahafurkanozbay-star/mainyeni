import { arcgisToGeoJSON } from '@terraformer/arcgis';
import SpatialReference from '@arcgis/core/geometry/SpatialReference.js';
import * as projectOperator from '@arcgis/core/geometry/operators/projectOperator.js';
import type { GeometryUnion } from '@arcgis/core/geometry/types.js';
import * as FileSaver from 'file-saver';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import * as XLSX from 'xlsx';

import {
  createKmlDocument,
  type KmlDataRecord,
  type KmlGeometry,
} from '../../runtime/kmlSerializer';
import { exportFont } from '../Fonts/UbuntuNormal';

type DataRecord = Record<string, unknown>;

const PROJECTABLE_GEOMETRY_TYPES = new Set([
  'point',
  'multipoint',
  'polyline',
  'polygon',
  'extent',
]);

const isProjectableGeometry = (value: unknown): value is GeometryUnion => {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && PROJECTABLE_GEOMETRY_TYPES.has(type);
};

const isKmlGeometry = (value: unknown): value is KmlGeometry => {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'Point'
    || type === 'MultiPoint'
    || type === 'LineString'
    || type === 'MultiLineString'
    || type === 'Polygon'
    || type === 'MultiPolygon';
};

const triggerTextDownload = (
  content: string,
  filename: string,
  mimeType: string,
): void => {
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

const projectForKml = async (
  geometries: readonly unknown[],
): Promise<readonly KmlGeometry[]> => {
  if (!projectOperator.isLoaded()) {
    await projectOperator.load();
  }

  const outSpatialReference = new SpatialReference({ wkid: 4326 });
  const projected = geometries
    .filter(isProjectableGeometry)
    .map((geometry) => projectOperator.execute(geometry, outSpatialReference))
    .filter((geometry): geometry is NonNullable<typeof geometry> => geometry != null);

  return Object.freeze(
    projected
      .map((geometry) => arcgisToGeoJSON(geometry.toJSON()))
      .filter(isKmlGeometry),
  );
};

export const DataHelper = {
  ExportJsonToCsv: async (
    json: readonly DataRecord[],
    fields: readonly string[],
    filename: string,
  ): Promise<void> => {
    const replacer = (_key: string, value: unknown): unknown =>
      value === null ? '' : value;
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

    const fileType =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8';
    const worksheet = XLSX.utils.json_to_sheet(resultData);
    const workbook = { Sheets: { data: worksheet }, SheetNames: ['data'] };
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    FileSaver.saveAs(
      new Blob([excelBuffer], { type: fileType }),
      `${filename}.xlsx`,
    );
  },

  ExportJsonToPdf: async (
    json: readonly DataRecord[],
    fields: readonly string[],
    filename: string,
  ): Promise<void> => {
    const rows = json.map((item) => fields.map((field) => item[field] ?? ''));
    exportFont();

    const doc = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: [697, 210],
    });
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
    attributes?: readonly KmlDataRecord[] | null,
  ): Promise<readonly KmlGeometry[] | null> => {
    if (!geometries || geometries.length === 0) return null;

    const geoJsonList = await projectForKml(geometries);
    if (geoJsonList.length === 0) return null;

    const kml = createKmlDocument(geoJsonList, attributes ?? []);
    triggerTextDownload(
      kml,
      'export.kml',
      'application/vnd.google-earth.kml+xml;charset=utf-8',
    );
    return geoJsonList;
  },
};
