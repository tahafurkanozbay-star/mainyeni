import { describe, expect, it } from 'vitest';
import {
  resolveArcgisSketchCreateRequest,
  type ArcgisSketchCreateTool,
} from './sketchArcgisAdapter';
import type { SketchTool } from './sketchContracts';

describe('sketchArcgisAdapter create request mapping', () => {
  it.each([
    ['point', 'point'],
    ['polyline', 'polyline'],
    ['polygon', 'polygon'],
    ['circle', 'circle'],
    ['rectangle', 'rectangle'],
  ] as const)(
    'maps %s to the ArcGIS create tool %s in click mode',
    (tool, expectedTool) => {
      const request = resolveArcgisSketchCreateRequest(tool);
      expect(request).toEqual({
        tool: expectedTool,
        options: { mode: 'click' },
      });
    },
  );

  it('maps freehand to a supported polyline create request', () => {
    expect(resolveArcgisSketchCreateRequest('freehand')).toEqual({
      tool: 'polyline',
      options: { mode: 'freehand' },
    });
  });

  it('never emits the legacy freehand token as an ArcGIS create tool', () => {
    const tools: readonly Exclude<SketchTool, 'move' | 'clear'>[] = [
      'point',
      'polyline',
      'freehand',
      'polygon',
      'circle',
      'rectangle',
    ];
    const arcgisTools = tools.map((tool) => resolveArcgisSketchCreateRequest(tool).tool);
    expect(arcgisTools).not.toContain('freehand');
  });

  it('keeps every emitted tool inside the SDK-supported drawing set', () => {
    const supported = new Set<ArcgisSketchCreateTool>([
      'point',
      'polyline',
      'polygon',
      'circle',
      'rectangle',
    ]);
    const tools: readonly Exclude<SketchTool, 'move' | 'clear'>[] = [
      'point',
      'polyline',
      'freehand',
      'polygon',
      'circle',
      'rectangle',
    ];
    for (const tool of tools) {
      expect(supported.has(resolveArcgisSketchCreateRequest(tool).tool)).toBe(true);
    }
  });

  it('returns immutable request records', () => {
    const request = resolveArcgisSketchCreateRequest('freehand');
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.options)).toBe(true);
  });
});
