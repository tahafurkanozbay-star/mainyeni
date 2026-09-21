declare module '@terraformer/arcgis' {
  export function arcgisToGeoJSON(input: Record<string, unknown>): unknown;
}

declare module 'file-saver' {
  export function saveAs(
    data: Blob,
    filename?: string,
    options?: Readonly<Record<string, unknown>>,
  ): void;
}
