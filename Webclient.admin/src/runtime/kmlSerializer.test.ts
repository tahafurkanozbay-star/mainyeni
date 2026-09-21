import { createKmlDocument, type KmlGeometry } from './kmlSerializer';

describe('kmlSerializer', () => {
  test('serializes point geometry using KML 2.2 namespace', () => {
    const kml = createKmlDocument([
      { type: 'Point', coordinates: [32.8541, 39.9208] },
    ]);

    expect(kml).toContain('xmlns="http://www.opengis.net/kml/2.2"');
    expect(kml).toContain('<Point><coordinates>32.8541,39.9208</coordinates></Point>');
  });

  test('escapes attribute names and values', () => {
    const kml = createKmlDocument(
      [{ type: 'Point', coordinates: [32.85, 39.92] }],
      [{ 'name<&': 'A&B <C> "D" \'E\'' }],
    );

    expect(kml).toContain('name="name&lt;&amp;"');
    expect(kml).toContain('A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;');
    expect(kml).not.toContain('<C>');
  });

  test('serializes polygon outer and inner rings without mutating input', () => {
    const geometry: KmlGeometry = Object.freeze({
      type: 'Polygon',
      coordinates: Object.freeze([
        Object.freeze([
          Object.freeze([0, 0]),
          Object.freeze([10, 0]),
          Object.freeze([10, 10]),
          Object.freeze([0, 0]),
        ]),
        Object.freeze([
          Object.freeze([2, 2]),
          Object.freeze([3, 2]),
          Object.freeze([2, 2]),
        ]),
      ]),
    });

    const before = JSON.stringify(geometry);
    const kml = createKmlDocument([geometry]);

    expect(kml).toContain('<outerBoundaryIs>');
    expect(kml).toContain('<innerBoundaryIs>');
    expect(kml).toContain('0,0 10,0 10,10 0,0');
    expect(JSON.stringify(geometry)).toBe(before);
  });

  test('serializes multi geometries deterministically', () => {
    const kml = createKmlDocument([
      {
        type: 'MultiLineString',
        coordinates: [
          [[1, 2], [3, 4]],
          [[5, 6], [7, 8]],
        ],
      },
      {
        type: 'MultiPoint',
        coordinates: [[9, 10], [11, 12]],
      },
    ]);

    expect(kml.match(/<Placemark>/gu)).toHaveLength(2);
    expect(kml.match(/<MultiGeometry>/gu)).toHaveLength(2);
    expect(kml).toContain('1,2 3,4');
    expect(kml).toContain('<coordinates>11,12</coordinates>');
  });
});
