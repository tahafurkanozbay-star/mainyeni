declare module "tokml" {
  const tokml: (geojson: unknown, options?: Readonly<Record<string, unknown>>) => string;
  export default tokml;
}

declare module "file-saver" {
  export function saveAs(data: Blob | File | string, filename?: string): void;
}

declare module "xml-js" {
  export function xml2js(value: string, options?: Readonly<Record<string, unknown>>): Record<string, unknown>;
  export function js2xml(value: unknown, options?: Readonly<Record<string, unknown>>): string;
}
