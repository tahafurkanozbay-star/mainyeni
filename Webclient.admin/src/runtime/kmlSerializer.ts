export type KmlDataRecord = Readonly<Record<string, unknown>>;

export type KmlGeometry =
  | Readonly<{ type: 'Point'; coordinates: readonly number[] }>
  | Readonly<{ type: 'MultiPoint'; coordinates: readonly (readonly number[])[] }>
  | Readonly<{ type: 'LineString'; coordinates: readonly (readonly number[])[] }>
  | Readonly<{ type: 'MultiLineString'; coordinates: readonly (readonly (readonly number[])[])[] }>
  | Readonly<{ type: 'Polygon'; coordinates: readonly (readonly (readonly number[])[])[] }>
  | Readonly<{ type: 'MultiPolygon'; coordinates: readonly (readonly (readonly (readonly number[])[])[])[] }>;

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

const coordinateSequence = (
  coordinates: readonly (readonly number[])[],
): string => coordinates.map(coordinateTuple).join(' ');

const linearRing = (
  coordinates: readonly (readonly number[])[],
): string => `<LinearRing><coordinates>${coordinateSequence(coordinates)}</coordinates></LinearRing>`;

const polygonKml = (
  rings: readonly (readonly (readonly number[])[])[],
): string => {
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

const geometryToKml = (geometry: KmlGeometry): string => {
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
  }
};

const extendedDataToKml = (attributes: KmlDataRecord | undefined): string => {
  if (!attributes) return '';
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '';

  return `<ExtendedData>${entries
    .map(([name, value]) =>
      `<Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>`)
    .join('')}</ExtendedData>`;
};

export const createKmlDocument = (
  geometries: readonly KmlGeometry[],
  attributes: readonly KmlDataRecord[] = [],
): string => {
  const placemarks = geometries
    .map((geometry, index) => [
      '<Placemark>',
      '<styleUrl>#kent-rehberi-geometry</styleUrl>',
      extendedDataToKml(attributes[index]),
      geometryToKml(geometry),
      '</Placemark>',
    ].join(''))
    .join('');

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
