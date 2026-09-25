import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRiskAreas } from './change-risk-policy.mts';

test('release policy implementation cannot self-classify from application regex literals', () => {
  const policySource = `
    const BACKEND_API_CONTENT = /HttpClient|ControllerBase|MapGet/u;
    const GIS_CONTENT = /FeatureLayer|MapView|SceneView/u;
    const SECURITY_CONTENT = /Authorization|Bearer|dangerouslySetInnerHTML/u;
  `;

  assert.deepEqual(
    classifyRiskAreas('quality/release/change-risk-policy.mts', policySource),
    ['release-tooling'],
  );
});

test('content classification remains active for real application sources', () => {
  assert.equal(
    classifyRiskAreas('Business/Parcel/ParcelEndpoint.cs', 'using var client = new HttpClient();').includes('backend-api'),
    true,
  );
  assert.equal(
    classifyRiskAreas('Webclient.app/src/runtime/view.ts', "import MapView from '@arcgis/core/views/MapView';").includes('gis'),
    true,
  );
});
