import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

// Keep privacy regression coverage aligned with the production client after
// API-backed query windows were removed. These are real remaining call sites.
for (const [path, minimumCalls] of [
  ['Webclient.app/src/Components/Query/GenelAramaQuery/GenelAramaQeryWindow.tsx', 1],
  ['Webclient.app/src/Components/Query/ParklarQuery/ParklarQueryWindow.tsx', 3],
] as const) {
  test(`production client log privacy: ${path}`, () => {
    const source = readFileSync(decodeURIComponent(new URL(`../../${path}`, import.meta.url).pathname), 'utf8');
    const audit = auditClientLogPrivacy(fixtureInventory([{ path, text: source }]));
    assert.equal(audit.summary.runtimeFiles, 1);
    assert.ok(audit.summary.clientLogCalls >= minimumCalls, 'logging contract unexpectedly removed');
    assert.equal(audit.summary.flaggedCalls, 0, JSON.stringify(audit.findings));
  });
}
