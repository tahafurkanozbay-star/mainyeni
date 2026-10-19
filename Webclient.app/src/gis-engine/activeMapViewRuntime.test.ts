import { afterEach, describe, expect, it } from 'vitest';
import { clearActiveMapView, getActiveMapView, setActiveMapView } from './activeMapViewRuntime';

afterEach(() => { clearActiveMapView(); });

describe('active map view runtime', () => {
  it('uses a SceneView while 3D is active and falls back to MapView in 2D', () => {
    const mapView = { id: 'map-view' };
    const sceneView = { id: 'scene-view' };

    expect(getActiveMapView(mapView)).toBe(mapView);
    setActiveMapView(sceneView);
    expect(getActiveMapView(mapView)).toBe(sceneView);
    clearActiveMapView(sceneView);
    expect(getActiveMapView(mapView)).toBe(mapView);
  });

  it('does not clear a newer active view when an old view unmounts', () => {
    const older = { id: 'older-scene' };
    const newer = { id: 'newer-scene' };
    setActiveMapView(newer);

    expect(clearActiveMapView(older)).toBe(false);
    expect(getActiveMapView(null)).toBe(newer);
  });
});
