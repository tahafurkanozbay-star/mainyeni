import { describe, expect, it } from 'vitest';
import { createArcGisResultWorkspaceExperience } from './ArcGisResultWorkspaceExperiencePolicy';
import { dispatchArcGisResultWorkspaceCommand } from './ArcGisResultWorkspaceCommandExperiencePolicy';

const snapshot = () => createArcGisResultWorkspaceExperience({
  heading: 'Sonuçlar',
  status: 'ready',
  rows: [
    { key: 'a', title: 'A', fields: [] },
    { key: 'b', title: 'B', fields: [] },
  ],
}, { viewportWidth: 1280, viewportHeight: 800 });

describe('ArcGisResultWorkspaceCommandExperiencePolicy', () => {
  it('maps workspace mnemonics to existing workspace intents', () => {
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'M', shiftKey: true } }).intent).toEqual({ type: 'show-map' });
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'R', shiftKey: true } }).intent).toEqual({ type: 'show-results' });
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'F', shiftKey: true } }).intent).toEqual({ type: 'toggle-filters' });
  });

  it('cycles only through bounded sanitized landmarks', () => {
    const result = dispatchArcGisResultWorkspaceCommand({
      snapshot: snapshot(),
      event: { key: 'F6' },
      landmarkIds: [' map ', 'results', 'results', '\u0000filters'],
      activeLandmarkId: 'map',
    });
    expect(result.focusElementId).toBe('results');
    expect(result.handled).toBe(true);
    expect(result.preventDefault).toBe(true);
  });

  it('wraps landmark navigation in both directions', () => {
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'F6' }, landmarkIds: ['map', 'results'], activeLandmarkId: 'results' }).focusElementId).toBe('map');
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'F6', shiftKey: true }, landmarkIds: ['map', 'results'], activeLandmarkId: 'map' }).focusElementId).toBe('results');
  });

  it('does not consume F6 when no focusable landmark is admitted', () => {
    const result = dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'F6' }, landmarkIds: ['', '\u0000'] });
    expect(result.handled).toBe(false);
    expect(result.preventDefault).toBe(false);
    expect(result.focusElementId).toBeNull();
  });

  it('preserves editable and IME suppression from the shortcut authority', () => {
    for (const event of [{ key: 'F6', editable: true }, { key: 'F6', composing: true }, { key: 'M', shiftKey: true, ctrlKey: true }]) {
      const result = dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event });
      expect(result.handled).toBe(false);
      expect(result.preventDefault).toBe(false);
      expect(result.intent).toBeNull();
    }
  });

  it('does not fabricate result-dependent commands without focus', () => {
    const current = snapshot();
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: current, event: { key: 'Enter', shiftKey: true } }).handled).toBe(false);
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: current, event: { key: ' ', shiftKey: true } }).handled).toBe(false);
  });

  it('publishes deterministic focus destinations for shell adapters', () => {
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'M', shiftKey: true } }).focusTarget).toBe('map');
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'R', shiftKey: true } }).focusTarget).toBe('results');
    expect(dispatchArcGisResultWorkspaceCommand({ snapshot: snapshot(), event: { key: 'F', shiftKey: true } }).focusTarget).toBe('filters');
  });
});
