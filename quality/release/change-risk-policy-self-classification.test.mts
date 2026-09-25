import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { classifyRiskAreas } from './change-risk-policy.mts';

test('release policy source does not masquerade as backend application code', () => {
  const path = 'quality/release/change-risk-policy.mts';
  const text = readFileSync(new URL('./change-risk-policy.mts', import.meta.url), 'utf8');
  const areas = classifyRiskAreas(path, text);

  assert.ok(areas.includes('release-tooling'));
  assert.equal(
    areas.includes('backend-api'),
    false,
    'policy regex literals must not create backend-api ownership for the policy implementation itself',
  );
});
