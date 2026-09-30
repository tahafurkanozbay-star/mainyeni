import { describe, expect, it } from 'vitest';
import {
  analyzeCoordinateQueryV7,
  coordinateQueryFingerprintV7,
} from './coordinateQueryRuntimeV7';
import {
  analyzeSearchIntentV7,
  searchIntentFingerprintV7,
  searchIntentRequiresAddressV7,
  searchIntentRequiresSpatialV7,
  searchIntentRequiresTextV7,
} from './searchIntentRuntimeV7';

describe('coordinate query runtime v7', () => {
  it('parses labeled latitude and longitude', () => {
    const result = analyzeCoordinateQueryV7('lat: 39.9208 lon: 32.8541');
    expect(result.kind).toBe('labeled');
    expect(result.order).toBe('lat-lon');
    expect(result.confidence).toBe('strong');
    expect(result.coordinates).toEqual({ latitude: 39.9208, longitude: 32.8541 });
    expect(result.residualQuery).toBe('');
    expect(result.diagnostics.explicitOrder).toBe(true);
  });

  it('parses Turkish coordinate labels', () => {
    const result = analyzeCoordinateQueryV7('enlem=39.93 boylam=32.86');
    expect(result.kind).toBe('labeled');
    expect(result.coordinates?.latitude).toBe(39.93);
    expect(result.coordinates?.longitude).toBe(32.86);
  });

  it('accepts longitude before latitude labels without swapping values', () => {
    const result = analyzeCoordinateQueryV7('boylam:32.85 enlem:39.92');
    expect(result.coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
    expect(result.order).toBe('lat-lon');
  });

  it('parses WKT POINT in longitude-latitude order', () => {
    const result = analyzeCoordinateQueryV7('POINT(32.8541 39.9208)');
    expect(result.kind).toBe('wkt-point');
    expect(result.order).toBe('lon-lat');
    expect(result.coordinates).toEqual({ latitude: 39.9208, longitude: 32.8541 });
  });

  it('removes WKT from a hybrid text query', () => {
    const result = analyzeCoordinateQueryV7('hastane POINT(32.8541 39.9208) acil');
    expect(result.coordinates).not.toBeNull();
    expect(result.residualQuery).toBe('hastane acil');
  });

  it('parses north/east directional pairs', () => {
    const result = analyzeCoordinateQueryV7('39.9208N 32.8541E');
    expect(result.kind).toBe('directional-pair');
    expect(result.coordinates).toEqual({ latitude: 39.9208, longitude: 32.8541 });
  });

  it('parses south/west directional pairs with negative signs', () => {
    const result = analyzeCoordinateQueryV7('12.5S 45.25W');
    expect(result.coordinates).toEqual({ latitude: -12.5, longitude: -45.25 });
  });

  it('parses longitude-first directional pairs', () => {
    const result = analyzeCoordinateQueryV7('32.8541E 39.9208N');
    expect(result.order).toBe('lon-lat');
    expect(result.coordinates).toEqual({ latitude: 39.9208, longitude: 32.8541 });
  });

  it('rejects two latitude directions', () => {
    const result = analyzeCoordinateQueryV7('39.9N 40.1S');
    expect(result.kind).toBe('none');
    expect(result.coordinates).toBeNull();
  });

  it('uses latitude-longitude as default for ambiguous decimal pairs', () => {
    const result = analyzeCoordinateQueryV7('39.9208, 32.8541');
    expect(result.kind).toBe('decimal-pair');
    expect(result.order).toBe('lat-lon');
    expect(result.confidence).toBe('weak');
    expect(result.diagnostics.ambiguousOrder).toBe(true);
  });

  it('can prefer longitude-latitude for ambiguous decimal pairs', () => {
    const result = analyzeCoordinateQueryV7('39.9208, 32.8541', {
      ambiguousOrder: 'lon-lat',
    });
    expect(result.order).toBe('lon-lat');
    expect(result.coordinates).toEqual({ latitude: 32.8541, longitude: 39.9208 });
  });

  it('can reject ambiguous coordinate order', () => {
    const result = analyzeCoordinateQueryV7('39.9208, 32.8541', {
      ambiguousOrder: 'reject',
    });
    expect(result.kind).toBe('none');
    expect(result.coordinates).toBeNull();
    expect(result.diagnostics.rejectedReason).toBe('ambiguous-coordinate-order');
  });

  it('infers latitude-longitude when only that order is valid', () => {
    const result = analyzeCoordinateQueryV7('39.9, 120.1');
    expect(result.order).toBe('lat-lon');
    expect(result.coordinates).toEqual({ latitude: 39.9, longitude: 120.1 });
    expect(result.confidence).toBe('strong');
  });

  it('infers longitude-latitude when only that order is valid', () => {
    const result = analyzeCoordinateQueryV7('120.1, 39.9');
    expect(result.order).toBe('lon-lat');
    expect(result.coordinates).toEqual({ latitude: 39.9, longitude: 120.1 });
  });

  it('rejects coordinates outside both valid orders', () => {
    const result = analyzeCoordinateQueryV7('200.1, 120.1');
    expect(result.kind).toBe('none');
    expect(result.diagnostics.rejectedReason).toBe('coordinate-out-of-range');
  });

  it('rejects explicit labeled latitude outside range', () => {
    const result = analyzeCoordinateQueryV7('lat: 120 lon: 32');
    expect(result.coordinates).toBeNull();
    expect(result.diagnostics.rejectedReason).toBe('coordinate-out-of-range');
  });

  it('does not interpret ordinary address integers as coordinates', () => {
    const result = analyzeCoordinateQueryV7('Atatürk Bulvarı No 12 34 Çankaya');
    expect(result.kind).toBe('none');
    expect(result.residualQuery).toBe('Atatürk Bulvarı No 12 34 Çankaya');
  });

  it('can opt into unlabeled integer pairs explicitly', () => {
    const result = analyzeCoordinateQueryV7('39, 32', {
      allowUnlabeledIntegerPairs: true,
    });
    expect(result.kind).toBe('decimal-pair');
    expect(result.coordinates).toEqual({ latitude: 39, longitude: 32 });
  });

  it('does not parse a single decimal number', () => {
    const result = analyzeCoordinateQueryV7('yaklaşık 39.92 kilometre');
    expect(result.kind).toBe('none');
  });

  it('parses two decimal values separated only by whitespace', () => {
    const result = analyzeCoordinateQueryV7('39.9208 32.8541');
    expect(result.coordinates).toEqual({ latitude: 39.9208, longitude: 32.8541 });
  });

  it('retains text before and after a decimal coordinate pair', () => {
    const result = analyzeCoordinateQueryV7('yakın 39.9208,32.8541 park');
    expect(result.residualQuery).toBe('yakın park');
  });

  it('bounds coordinate input before parsing', () => {
    const value = `${'x'.repeat(80)} 39.92, 32.85`;
    const result = analyzeCoordinateQueryV7(value, { maximumInputLength: 32 });
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.boundedLength).toBe(32);
    expect(result.coordinates).toBeNull();
  });

  it('normalizes empty input to a stable none intent', () => {
    const result = analyzeCoordinateQueryV7('   ');
    expect(result.kind).toBe('none');
    expect(result.confidence).toBe('none');
    expect(result.residualQuery).toBe('');
  });

  it('creates stable coordinate fingerprints for identical normalized inputs', () => {
    const left = coordinateQueryFingerprintV7('39.9208, 32.8541');
    const right = coordinateQueryFingerprintV7('  39.9208,   32.8541  ');
    expect(left).toBe(right);
  });

  it('changes fingerprints when coordinate order policy changes semantics', () => {
    const left = coordinateQueryFingerprintV7('39.9208, 32.8541', {
      ambiguousOrder: 'lat-lon',
    });
    const right = coordinateQueryFingerprintV7('39.9208, 32.8541', {
      ambiguousOrder: 'lon-lat',
    });
    expect(left).not.toBe(right);
  });

  it('changes fingerprints when residual query changes', () => {
    const left = coordinateQueryFingerprintV7('39.9208, 32.8541 park');
    const right = coordinateQueryFingerprintV7('39.9208, 32.8541 hastane');
    expect(left).not.toBe(right);
  });
});

describe('search intent runtime v7', () => {
  it('classifies an empty request as empty', () => {
    const result = analyzeSearchIntentV7({});
    expect(result.kind).toBe('empty');
    expect(result.centerSource).toBe('none');
    expect(searchIntentRequiresTextV7(result)).toBe(false);
    expect(searchIntentRequiresAddressV7(result)).toBe(false);
    expect(searchIntentRequiresSpatialV7(result)).toBe(false);
  });

  it('classifies ordinary free text as text', () => {
    const result = analyzeSearchIntentV7({ query: 'kültür merkezi' });
    expect(result.kind).toBe('text');
    expect(result.text.positiveTerms).toEqual(['kultur', 'merkezi']);
    expect(result.evidence.hasResidualText).toBe(true);
    expect(searchIntentRequiresTextV7(result)).toBe(true);
  });

  it('classifies a structured street query as address', () => {
    const result = analyzeSearchIntentV7({
      query: 'Atatürk Bulvarı No 10 Çankaya',
    });
    expect(result.kind).toBe('address');
    expect(result.evidence.addressEvidenceScore).toBeGreaterThanOrEqual(3);
    expect(searchIntentRequiresAddressV7(result)).toBe(true);
  });

  it('classifies postal evidence as address', () => {
    const result = analyzeSearchIntentV7({ query: '06420 Kızılay' });
    expect(result.kind).toBe('address');
    expect(result.evidence.addressPostalTokens).toBeGreaterThan(0);
  });

  it('classifies explicit hierarchy with text as address', () => {
    const result = analyzeSearchIntentV7({
      query: 'merkezi',
      district: 'Çankaya',
    });
    expect(result.kind).toBe('address');
    expect(result.diagnostics.explicitHierarchy).toBe(true);
    expect(result.evidence.hierarchyHints).toBe(1);
  });

  it('classifies hierarchy-only request as address', () => {
    const result = analyzeSearchIntentV7({
      district: 'Çankaya',
      neighborhood: 'Kızılay',
    });
    expect(result.kind).toBe('address');
    expect(result.evidence.hasResidualText).toBe(false);
  });

  it('classifies explicit center without text as coordinate', () => {
    const result = analyzeSearchIntentV7({
      center: { latitude: 39.92, longitude: 32.85 },
    });
    expect(result.kind).toBe('coordinate');
    expect(result.centerSource).toBe('request');
    expect(searchIntentRequiresSpatialV7(result)).toBe(true);
  });

  it('classifies a coordinate literal without residual text as coordinate', () => {
    const result = analyzeSearchIntentV7({ query: '39.92, 32.85' });
    expect(result.kind).toBe('coordinate');
    expect(result.centerSource).toBe('query');
    expect(result.residualQuery).toBe('');
  });

  it('classifies coordinate plus free text as hybrid', () => {
    const result = analyzeSearchIntentV7({
      query: '39.92, 32.85 hastane',
    });
    expect(result.kind).toBe('hybrid');
    expect(result.residualQuery).toBe('hastane');
    expect(searchIntentRequiresTextV7(result)).toBe(true);
    expect(searchIntentRequiresSpatialV7(result)).toBe(true);
  });

  it('classifies explicit center plus address query as hybrid', () => {
    const result = analyzeSearchIntentV7({
      query: 'Atatürk Bulvarı',
      center: { latitude: 39.92, longitude: 32.85 },
    });
    expect(result.kind).toBe('hybrid');
    expect(result.centerSource).toBe('request');
  });

  it('gives explicit request center precedence over query coordinate', () => {
    const result = analyzeSearchIntentV7({
      query: '39.92, 32.85 park',
      center: { latitude: 40, longitude: 33 },
    });
    expect(result.center).toEqual({ latitude: 40, longitude: 33 });
    expect(result.centerSource).toBe('request');
    expect(result.coordinate.coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
  });

  it('reports invalid explicit center fail-closed evidence', () => {
    const result = analyzeSearchIntentV7({
      query: 'park',
      center: [999, 999],
    });
    expect(result.center).toBeNull();
    expect(result.diagnostics.invalidExplicitCenter).toBe(true);
  });

  it('does not let ordinary house numbers become spatial intent', () => {
    const result = analyzeSearchIntentV7({
      query: 'Hoşdere Caddesi No 12 34',
    });
    expect(result.center).toBeNull();
    expect(result.centerSource).toBe('none');
    expect(result.kind).toBe('address');
  });

  it('exposes coordinate ambiguity through intent diagnostics', () => {
    const result = analyzeSearchIntentV7({ query: '39.92,32.85 park' });
    expect(result.diagnostics.coordinateAmbiguous).toBe(true);
  });

  it('can reject ambiguous query coordinates through intent policy', () => {
    const result = analyzeSearchIntentV7(
      { query: '39.92,32.85 park' },
      { coordinate: { ambiguousOrder: 'reject' } },
    );
    expect(result.center).toBeNull();
    expect(result.kind).not.toBe('coordinate');
  });

  it('supports stricter address classification thresholds', () => {
    const defaultResult = analyzeSearchIntentV7({ query: 'Atatürk Bulvarı' });
    const strictResult = analyzeSearchIntentV7(
      { query: 'Atatürk Bulvarı' },
      { minimumAddressEvidence: 12 },
    );
    expect(defaultResult.evidence.addressEvidenceScore)
      .toBe(strictResult.evidence.addressEvidenceScore);
    expect(strictResult.kind).toBe('text');
  });

  it('bounds hierarchy evidence count', () => {
    const result = analyzeSearchIntentV7({
      query: 'adres',
      level: 'address',
      district: 'Çankaya',
      neighborhood: 'Kızılay',
      street: 'Atatürk Bulvarı',
    }, {
      maximumHierarchyHints: 2,
    });
    expect(result.evidence.hierarchyHints).toBe(2);
  });

  it('creates stable signatures for canonically equivalent Turkish query casing', () => {
    const left = searchIntentFingerprintV7({ query: 'ÇANKAYA park' });
    const right = searchIntentFingerprintV7({ query: 'çankaya PARK' });
    expect(left).toBe(right);
  });

  it('changes signature when center changes', () => {
    const left = searchIntentFingerprintV7({
      query: 'park',
      center: { latitude: 39.92, longitude: 32.85 },
    });
    const right = searchIntentFingerprintV7({
      query: 'park',
      center: { latitude: 39.93, longitude: 32.85 },
    });
    expect(left).not.toBe(right);
  });

  it('changes signature when hierarchy semantics change', () => {
    const left = searchIntentFingerprintV7({ query: 'park', district: 'Çankaya' });
    const right = searchIntentFingerprintV7({ query: 'park', district: 'Keçiören' });
    expect(left).not.toBe(right);
  });

  it('keeps intent analysis immutable', () => {
    const result = analyzeSearchIntentV7({ query: '39.92,32.85 park' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });
});
