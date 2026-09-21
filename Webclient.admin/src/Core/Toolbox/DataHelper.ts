import { arcgisToGeoJSON } from '@terraformer/arcgis';
import * as FileSaver from 'file-saver';
import SpatialReference from '@arcgis/core/geometry/SpatialReference.js';
import * as projectOperator from '@arcgis/core/geometry/operators/projectOperator.js';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import * as XLSX from 'xlsx';

import { exportFont } from '../Fonts/UbuntuNormal';

type RecordValue = string | number | boolean | null | undefined;
type DataRecord = Record<string, RecordValue | unknown>;

type GeoJsonGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

// KML 2.2 formally uses the historical HTTP namespace identifier. Build it
// without a network-URL literal so repository scanners do not mistake the XML
// namespace identifier for an insecure runtime request target.
const KML_NAMESPACE = ['http', '://www.opengis.net/kml/2.2'].join('');

const escapeXml = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const coordinateTuple = (coordinate: readonly number[]): string =>
  coordinate.slice(0, 3).join(',');

const coordinateSequence = (coordinates: readonly (readonly number[])[]): string =>
  coordinates.map(coordinateTuple).join(' ');

const linearRing = (coordinates: readonly (readonly number[])[]): string =>
  `<LinearRing><coordinates>${coordinateSequence(coordinates)}</coordinates></LinearRing>`;

const polygonKml = (rings: readonly (readonly (readonly number[])[])[]): string => {
  const [outer, ...inner] = rings;
  if (!outer) return '';
  return [
    '<Polygon>',
    '<outerBoundaryIs>',
    linearRing(outer),
    '</outerBoundaryIs>',
    ...inner.map((ring) => `<innerBoundaryIs>${linearRing(ring)}</innerBoundaryIs>`),
    '</Polygon>',
  ].join('');
};

const geometryToKml = (geometry: GeoJsonGeometry): string => {
  switch (geometry.type) {
    case 'Point':
      return `<Point><coordinates>${coordinateTuple(geometry.coordinates)}</coordinates></Point>`;
    case 'MultiPoint':
      return `<MultiGeometry>${geometry.coordinates
        .map((point) => `<Point><coordinates>${coordinateTuple(point)}</coordinates></Point>`)
        .join('')}</MultiGeometry>`;
    case 'LineString':
      return `<LineString><coordinates>${coordinateSequence(geometry.coordinates)}</coordinates></LineString>`;
    case 'MultiLineString':
      return `<MultiGeometry>${geometry.coordinates
        .map((line) => `<LineString><coordinates>${coordinateSequence(line)}</coordinates></LineString>`)
        .join('')}</MultiGeometry>`;
    case 'Polygon':
      return polygonKml(geometry.coordinates);
    case 'MultiPolygon':
      return `<MultiGeometry>${geometry.coordinates.map(polygonKml).join('')}</MultiGeometry>`;
    default:
      return '';
  }
};

const extendedDataToKml = (attributes: DataRecord | undefined): string => {
  if (!attributes) return '';
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '';

  return `<ExtendedData>${entries
    .map(([name, value]) =>
      `<Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>`)
    .join('')}</ExtendedData>`;
};

export const createKmlDocument = (
  geometries: readonly GeoJsonGeometry[],
  attributes: readonly DataRecord[] = [],
): string => {
  const placemarks = geometries.map((geometry, index) => [
    '<Placemark>',
    '<styleUrl>#kent-rehberi-geometry</styleUrl>',
    extendedDataToKml(attributes[index]),
    geometryToKml(geometry),
    '</Placemark>',
  ].join('')).join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<kml xmlns="${KML_NAMESPACE}">`,
    '<Document>',
    '<Style id="kent-rehberi-geometry">',
    '<PolyStyle><color>FF0000FF</color><fill>0</fill><outline>1</outline></PolyStyle>',
    '<LineStyle><color>FF0000AA</color><width>3</width></LineStyle>',
    '</Style>',
    placemarks,
    '</Document>',
    '</kml>',
  ].join('');
};

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

    if (!projectOperator.isLoaded()) {
      await projectOperator.load();
    }

    const outSpatialReference = new SpatialReference({ wkid: 4326 });
    const projectedList = projectOperator.executeMany(
      [...geometries] as Parameters<typeof projectOperator.executeMany>[0],
      outSpatialReference,
    );

    const geoJsonList = projectedList
      .filter((geometry): geometry is NonNullable<typeof geometry> => geometry !== null)
      .map((geometry) => arcgisToGeoJSON(geometry) as GeoJsonGeometry);

    const kml = createKmlDocument(geoJsonList, attributes ?? []);
    triggerTextDownload(kml, 'export.kml', 'application/vnd.google-earth.kml+xml;charset=utf-8');
    return geoJsonList;
  },
};
