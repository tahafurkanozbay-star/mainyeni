import type Geometry from "@arcgis/core/geometry/Geometry.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as projectOperator from "@arcgis/core/geometry/operators/projectOperator.js";
import { arcgisToGeoJSON } from "@terraformer/arcgis";
import { saveAs } from "file-saver";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import tokml from "tokml";
import * as XLSX from "xlsx";
import { js2xml, xml2js } from "xml-js";
import { exportFont } from "../Fonts/UbuntuNormal";
import { isRecord, readString } from "../../platform/contracts";
import { reportAdminError } from "../../platform/diagnostics";

export type ExportRecord = Readonly<Record<string, unknown>>;

export interface KmlFeature {
  readonly type: "Feature";
  readonly properties: ExportRecord;
  readonly geometry: unknown;
}

const normalizeFilename = (value: unknown, fallback: string): string => {
  const text = readString(value) ?? fallback;
  const sanitized = text.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim();
  return sanitized.slice(0, 160) || fallback;
};

const normalizeFields = (fields: readonly unknown[]): readonly string[] =>
  Object.freeze(
    fields
      .map((field) => readString(field))
      .filter((field): field is string => field !== null),
  );

const quoteCsvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const safe = text ?? String(value);
  return `"${safe.replaceAll('"', '""')}"`;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
};

const writeCsv = (
  records: readonly ExportRecord[],
  fields: readonly string[],
): string => {
  const header = fields.map(quoteCsvCell).join(",");
  const rows = records.map((record) =>
    fields.map((field) => quoteCsvCell(record[field])).join(","));
  return ["\uFEFF" + header, ...rows].join("\r\n");
};

const asPlainRecord = (value: unknown): ExportRecord =>
  isRecord(value) ? value : Object.freeze({});

const projectToWgs84 = async (
  geometries: readonly Geometry[],
): Promise<readonly Geometry[]> => {
  if (!geometries.length) return Object.freeze([]);
  if (!projectOperator.isLoaded()) await projectOperator.load();

  const outSpatialReference = new SpatialReference({ wkid: 4326 });
  const projected = projectOperator.executeMany(
    geometries as Parameters<typeof projectOperator.executeMany>[0],
    outSpatialReference,
  );
  return Object.freeze([...(projected as readonly Geometry[])]);
};

const styleKml = (kml: string): string => {
  const documentObject = xml2js(kml, { compact: true, spaces: 4 });
  if (!isRecord(documentObject.kml) || !isRecord(documentObject.kml.Document)) return kml;

  const documentNode = documentObject.kml.Document as Record<string, unknown>;
  documentNode.Style = {
    _attributes: { id: "polygon-style" },
    PolyStyle: {
      color: "FF0000FF",
      fill: 0,
      outline: 1,
    },
    LineStyle: {
      color: "FF0000AA",
      width: "3",
    },
  };

  const placemark = documentNode.Placemark;
  if (Array.isArray(placemark)) {
    for (const item of placemark) {
      if (isRecord(item)) (item as Record<string, unknown>).styleUrl = "polygon-style";
    }
  } else if (isRecord(placemark)) {
    (placemark as Record<string, unknown>).styleUrl = "polygon-style";
  }

  return js2xml(documentObject, { compact: true, spaces: 4 });
};

export const DataHelper = Object.freeze({
  ExportJsonToCsv: async (
    json: readonly ExportRecord[],
    fields: readonly unknown[],
    filename: unknown,
  ): Promise<void> => {
    const normalizedFields = normalizeFields(fields);
    if (!normalizedFields.length) throw new Error("CSV export için en az bir alan gereklidir.");
    const csv = writeCsv(json, normalizedFields);
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      normalizeFilename(filename, "export.csv").replace(/\.csv$/iu, "") + ".csv",
    );
  },

  ExportJsonToExcel: async (
    json: readonly ExportRecord[],
    fields: readonly unknown[],
    filename: unknown,
  ): Promise<void> => {
    const normalizedFields = normalizeFields(fields);
    if (!normalizedFields.length) throw new Error("Excel export için en az bir alan gereklidir.");

    const data = json.map((record) =>
      Object.fromEntries(normalizedFields.map((field) => [field, record[field]])));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = {
      Sheets: { data: worksheet },
      SheetNames: ["data"],
    };
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    saveAs(
      new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8",
      }),
      normalizeFilename(filename, "export").replace(/\.xlsx$/iu, "") + ".xlsx",
    );
  },

  ExportJsonToPdf: async (
    json: readonly ExportRecord[],
    fields: readonly unknown[],
    filename: unknown,
  ): Promise<void> => {
    const normalizedFields = normalizeFields(fields);
    if (!normalizedFields.length) throw new Error("PDF export için en az bir alan gereklidir.");

    exportFont();
    const document = new jsPDF({ orientation: "landscape", unit: "mm", format: [697, 210] });
    document.setFont("Ubuntu", "normal");
    autoTable(document, {
      head: [normalizedFields],
      body: json.map((record) => normalizedFields.map((field) => record[field] ?? "")),
      styles: { font: "Ubuntu" },
      theme: "grid",
      tableWidth: "auto",
    });
    document.save(
      normalizeFilename(filename, "export").replace(/\.pdf$/iu, "") + ".pdf",
    );
  },

  ExportGeometriesToKML: async (
    geometries: readonly Geometry[] | null | undefined,
    attributes?: readonly ExportRecord[] | null,
  ): Promise<readonly KmlFeature[] | null> => {
    if (!geometries?.length) return null;

    try {
      const projected = await projectToWgs84(geometries);
      const features = projected.map((geometry, index): KmlFeature => Object.freeze({
        type: "Feature",
        properties: asPlainRecord(attributes?.[index]),
        geometry: arcgisToGeoJSON(geometry.toJSON()),
      }));
      const collection = Object.freeze({
        type: "FeatureCollection",
        features,
      });
      const kml = tokml(collection);
      const styledKml = styleKml(kml);
      downloadBlob(
        new Blob(["\uFEFF", styledKml], { type: "application/vnd.google-earth.kml+xml;charset=utf-8" }),
        "export.kml",
      );
      return Object.freeze(features);
    } catch (error) {
      reportAdminError("export", "kml-export-failed", error);
      throw error;
    }
  },
});
