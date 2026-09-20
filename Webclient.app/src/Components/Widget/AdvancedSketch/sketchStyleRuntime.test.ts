import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKETCH_STYLE,
  normalizeFillStyle,
  normalizeHexColor,
  normalizeLineStyle,
  normalizeLineSymbol,
  normalizeLineWidth,
  normalizePointSize,
  normalizePointStyle,
  normalizeRgba,
  normalizeSketchStyle,
  rgbaToHex,
  toCssRgba,
  withFillColor,
  withFillStyle,
  withLineColor,
  withLineStyle,
  withLineWidth,
  withPointColor,
  withPointStyle,
} from './sketchStyleRuntime';

describe('sketchStyleRuntime', () => {
  it('normalizes 3-digit and 6-digit colors', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('#12abEF')).toBe('#12abef');
    expect(normalizeHexColor('invalid', '#123456')).toBe('#123456');
    expect(normalizeHexColor(null, '#654321')).toBe('#654321');
  });

  it('clamps rgba channels and alpha', () => {
    expect(normalizeRgba({ r: -4, g: 127.6, b: 999, a: 3 })).toEqual({
      r: 0,
      g: 128,
      b: 255,
      a: 1,
    });
    expect(normalizeRgba({ r: 1, g: 2, b: 3, a: -1 })).toEqual({
      r: 1,
      g: 2,
      b: 3,
      a: 0,
    });
  });

  it('converts rgba colors to stable hex and css', () => {
    expect(rgbaToHex({ r: 241, g: 112, b: 19, a: 1 })).toBe('#f17013');
    expect(toCssRgba({ r: 241, g: 112, b: 19, a: 0.5 }))
      .toBe('rgba(241, 112, 19, 0.5)');
  });

  it('bounds line width and point size', () => {
    expect(normalizeLineWidth(0)).toBe(0.5);
    expect(normalizeLineWidth(999)).toBe(20);
    expect(normalizeLineWidth(3.26)).toBe(3.5);
    expect(normalizePointSize(1)).toBe(4);
    expect(normalizePointSize(100)).toBe(64);
  });

  it('accepts known symbol styles and rejects arbitrary values', () => {
    expect(normalizePointStyle('diamond')).toBe('diamond');
    expect(normalizePointStyle('bogus')).toBe('circle');
    expect(normalizeFillStyle('diagonal-cross')).toBe('diagonal-cross');
    expect(normalizeFillStyle('bogus')).toBe('solid');
    expect(normalizeLineStyle('long-dash-dot')).toBe('long-dash-dot');
    expect(normalizeLineStyle('bogus')).toBe('solid');
  });

  it('normalizes incomplete line symbols without mutating defaults', () => {
    const result = normalizeLineSymbol({
      color: '#fff',
      width: 4,
      style: 'dash',
    });
    expect(result).toEqual({
      type: 'simple-line',
      color: '#ffffff',
      width: 4,
      style: 'dash',
    });
    expect(DEFAULT_SKETCH_STYLE.line).toEqual({
      type: 'simple-line',
      color: '#828282',
      width: 2,
      style: 'solid',
    });
  });

  it('normalizes an unknown style object to complete immutable defaults', () => {
    const result = normalizeSketchStyle({
      line: { color: '#123', width: 5 },
      polygon: { style: 'horizontal' },
      point: { style: 'square', size: 14 },
    });
    expect(result.line.color).toBe('#112233');
    expect(result.line.width).toBe(5);
    expect(result.polygon.style).toBe('horizontal');
    expect(result.polygon.outline).toBeDefined();
    expect(result.point.style).toBe('square');
    expect(result.point.size).toBe(14);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('updates line color in line and polygon outline atomically', () => {
    const result = withLineColor(DEFAULT_SKETCH_STYLE, '#010203');
    expect(result.line.color).toBe('#010203');
    expect(result.polygon.outline.color).toBe('#010203');
    expect(DEFAULT_SKETCH_STYLE.line.color).toBe('#828282');
  });

  it('updates line width in line and polygon outline atomically', () => {
    const result = withLineWidth(DEFAULT_SKETCH_STYLE, 8);
    expect(result.line.width).toBe(8);
    expect(result.polygon.outline.width).toBe(8);
    expect(DEFAULT_SKETCH_STYLE.line.width).toBe(2);
  });

  it('updates line style without mutating source style', () => {
    const result = withLineStyle(DEFAULT_SKETCH_STYLE, 'dash-dot');
    expect(result.line.style).toBe('dash-dot');
    expect(result.polygon.outline.style).toBe('dash-dot');
    expect(DEFAULT_SKETCH_STYLE.line.style).toBe('solid');
  });

  it('updates fill color and style independently', () => {
    const colored = withFillColor(DEFAULT_SKETCH_STYLE, '#ffeedd');
    const styled = withFillStyle(colored, 'vertical');
    expect(styled.polygon.color).toBe('#ffeedd');
    expect(styled.polygon.style).toBe('vertical');
    expect(styled.polygon.outline).toEqual(DEFAULT_SKETCH_STYLE.polygon.outline);
  });

  it('updates point color and style independently', () => {
    const colored = withPointColor(DEFAULT_SKETCH_STYLE, '#abcdef');
    const styled = withPointStyle(colored, 'cross');
    expect(styled.point.color).toBe('#abcdef');
    expect(styled.point.style).toBe('cross');
    expect(DEFAULT_SKETCH_STYLE.point.style).toBe('circle');
  });

  it.each([
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
    [undefined, 2],
    ['3', 3],
  ])('normalizes line width input %p', (input, expected) => {
    expect(normalizeLineWidth(input)).toBe(expected);
  });

  it.each([
    ['solid', 'solid'],
    ['short-dot', 'short-dot'],
    ['none', 'none'],
    ['', 'solid'],
    [null, 'solid'],
  ])('normalizes line style input %p', (input, expected) => {
    expect(normalizeLineStyle(input)).toBe(expected);
  });
});
