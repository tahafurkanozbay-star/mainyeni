import { describe, expect, it, vi } from 'vitest';
import type { SketchGraphicSnapshot } from './sketchContracts';
import {
  createSketchDocument,
  isFillStyle,
  isLineStyle,
  isPointStyle,
  parseSketchDocument,
  serializeSketchDocument,
} from './sketchDocumentRuntime';
import { DEFAULT_SKETCH_STYLE } from './sketchStyleRuntime';

const graphic = (id: string): SketchGraphicSnapshot => Object.freeze({
  id,
  geometry: Object.freeze({
    type: 'point',
    spatialReferenceWkid: 4326,
    payload: Object.freeze({ type: 'point', x: 32.85, y: 39.92 }),
  }),
  attributes: Object.freeze({ name: id }),
  symbol: null,
  createdAt: 10,
  updatedAt: 11,
});

describe('sketchDocumentRuntime', () => {
  it('creates versioned sketch documents', () => {
    const document = createSketchDocument(
      [graphic('a')],
      DEFAULT_SKETCH_STYLE,
      'Test',
      Object.freeze({ owner: 'local' }),
      new Date('2026-09-20T10:00:00.000Z'),
    );
    expect(document).toEqual(expect.objectContaining({
      schema: 'kent-rehberi-sketch',
      version: 1,
      exportedAt: '2026-09-20T10:00:00.000Z',
      title: 'Test',
    }));
    expect(document.graphics).toHaveLength(1);
  });

  it('round-trips valid documents through JSON', () => {
    const source = createSketchDocument([graphic('a'), graphic('b')]);
    const serialized = serializeSketchDocument(source);
    const parsed = parseSketchDocument(serialized);
    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.graphics.map((item) => item.id)).toEqual(['a', 'b']);
    expect(parsed.document?.style).toEqual(DEFAULT_SKETCH_STYLE);
  });

  it('rejects invalid JSON', () => {
    const result = parseSketchDocument('{not-json');
    expect(result.document).toBeNull();
    expect(result.errors).toContain('Sketch document is not valid JSON.');
  });

  it('rejects non-object roots', () => {
    const result = parseSketchDocument('[]');
    expect(result.document).toBeNull();
    expect(result.errors).toContain('Sketch document root must be an object.');
  });

  it('rejects unsupported schemas', () => {
    const result = parseSketchDocument({
      schema: 'foreign',
      version: 1,
      graphics: [],
    });
    expect(result.document).toBeNull();
    expect(result.errors).toContain('Unsupported sketch document schema.');
  });

  it('rejects unsupported versions', () => {
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 2,
      graphics: [],
    });
    expect(result.document).toBeNull();
    expect(result.errors).toContain('Unsupported sketch document version.');
  });

  it('requires a graphics array', () => {
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 1,
      graphics: {},
    });
    expect(result.document).toBeNull();
    expect(result.errors).toContain('Sketch document graphics must be an array.');
  });

  it('truncates documents above the graphic budget', () => {
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 1,
      graphics: [graphic('a'), graphic('b'), graphic('c')],
    }, { maxGraphics: 2 });
    expect(result.document?.graphics).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('truncated');
  });

  it('deduplicates graphic identifiers deterministically', () => {
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 1,
      graphics: [graphic('a'), graphic('a'), graphic('b')],
    });
    expect(result.document?.graphics.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.warnings.join(' ')).toContain('Duplicate');
  });

  it('creates stable fallback ids for missing identifiers', () => {
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 1,
      graphics: [
        { geometry: { type: 'point', payload: { x: 1, y: 2 } } },
        { geometry: { type: 'point', payload: { x: 3, y: 4 } } },
      ],
    });
    expect(result.document?.graphics.map((item) => item.id))
      .toEqual(['imported-1', 'imported-2']);
  });

  it('sanitizes prototype-pollution keys', () => {
    const source = JSON.parse(`{
      "schema":"kent-rehberi-sketch",
      "version":1,
      "graphics":[{
        "id":"safe",
        "geometry":{"type":"point","payload":{"x":1,"y":2}},
        "attributes":{"name":"safe","__proto__":{"polluted":true},"constructor":"bad"}
      }],
      "metadata":{"__proto__":{"polluted":true},"name":"safe"}
    }`);
    const result = parseSketchDocument(source);
    expect(result.document?.graphics[0]?.attributes.name).toBe('safe');
    expect(result.document?.graphics[0]?.attributes.__proto__).toBeUndefined();
    expect(result.document?.metadata.name).toBe('safe');
  });

  it('caps string lengths', () => {
    const long = 'x'.repeat(5_000);
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 1,
      title: long,
      graphics: [{
        id: 'a',
        geometry: { type: 'point', payload: { x: 1, y: 2 } },
        attributes: { description: long },
      }],
    }, { maxStringLength: 64 });
    expect(result.document?.title.length).toBeLessThanOrEqual(240);
    expect(String(result.document?.graphics[0]?.attributes.description)).toHaveLength(64);
  });

  it('caps recursive payload depth', () => {
    const nested = { a: { b: { c: { d: 'deep' } } } };
    const result = parseSketchDocument({
      schema: 'kent-rehberi-sketch',
      version: 1,
      graphics: [{
        id: 'a',
        geometry: { type: 'unknown', payload: nested },
      }],
    }, { maxPayloadDepth: 2 });
    const payload = result.document?.graphics[0]?.geometry.payload;
    expect(payload).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain('deep');
  });

  it('caps document bytes before parsing', () => {
    const huge = JSON.stringify({
      schema: 'kent-rehberi-sketch',
      version: 1,
      graphics: [],
      metadata: { payload: 'x'.repeat(5_000) },
    });
    const result = parseSketchDocument(huge, { maxDocumentBytes: 1_024 });
    expect(result.document).toBeNull();
    expect(result.errors.join(' ')).toContain('exceeds');
  });

  it('rejects serialization when byte budget is exceeded', () => {
    const source = createSketchDocument(
      [graphic('a')],
      DEFAULT_SKETCH_STYLE,
      'x'.repeat(240),
      Object.freeze({ payload: 'y'.repeat(5_000) }),
    );
    expect(() => serializeSketchDocument(source, { maxDocumentBytes: 1_024 }))
      .toThrow('exceeds');
  });

  it('normalizes invalid dates to a valid export timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    try {
      const result = parseSketchDocument({
        schema: 'kent-rehberi-sketch',
        version: 1,
        exportedAt: 'not-a-date',
        graphics: [],
      });
      expect(Date.parse(result.document?.exportedAt ?? '')).not.toBeNaN();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recognizes supported point styles', () => {
    expect(isPointStyle('circle')).toBe(true);
    expect(isPointStyle('square')).toBe(true);
    expect(isPointStyle('future')).toBe(false);
  });

  it('recognizes supported fill styles', () => {
    expect(isFillStyle('solid')).toBe(true);
    expect(isFillStyle('diagonal-cross')).toBe(true);
    expect(isFillStyle('future')).toBe(false);
  });

  it('recognizes supported line styles', () => {
    expect(isLineStyle('dash-dot')).toBe(true);
    expect(isLineStyle('short-dot')).toBe(true);
    expect(isLineStyle('future')).toBe(false);
  });
});
