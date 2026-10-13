import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

// These are real production call sites, not hand-copied snippets. A future
// address-bearing log argument must fail the release regression suite.
for (const [path, minimumCalls] of [
  ['Webclient.app/src/Components/Query/AAQuery/AAQueryWindow.tsx', 2],
  ['Webclient.app/src/Components/Query/GenelAramaQuery/GenelAramaQeryWindow.tsx', 1],
  ['Webclient.app/src/Components/Query/ParklarQuery/ParklarQueryWindow.tsx', 3],
  ['Webclient.app/src/Components/Query/VicinityQuery/VicinityQueryWindow.tsx', 3],
] as const) {
  test(`production client log privacy: ${path}`, () => {
    const text = readFileSync(decodeURIComponent(new URL(`../../${path}`, import.meta.url).pathname), 'utf8');
    const audit = auditClientLogPrivacy(fixtureInventory([{ path, text }]));
    assert.equal(audit.summary.runtimeFiles, 1);
    assert.ok(audit.summary.clientLogCalls >= minimumCalls, 'logging contract unexpectedly removed');
    assert.equal(audit.summary.flaggedCalls, 0, JSON.stringify(audit.findings));
  });
}
