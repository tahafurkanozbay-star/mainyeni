import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDataIntegrity } from './data-integrity-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function ids(...files: Parameters<typeof fixtureInventory>[0]): string[] { return auditDataIntegrity(fixtureInventory(files)).findings.map(finding => finding.id); }

test('blocks invalid runtime JSON', () => { const section = auditDataIntegrity(fixtureInventory([{ path: 'Webclient.app/src/config/runtime.json', text: '{"bad":', kind: 'json' }])); const finding = section.findings.find(item => item.id === 'data-invalid-json'); assert.equal(finding?.blocking, true); assert.equal(finding?.severity, 'critical'); assert.equal(section.summary.parseFailures, 1); });
test('accepts valid runtime JSON', () => { assert.ok(!ids({ path: 'Webclient.app/src/config/runtime.json', text: '{"ok":true}', kind: 'json' }).includes('data-invalid-json')); });
test('flags lossy coercion of global identifiers', () => { assert.ok(ids({ path: 'Webclient.app/src/data/records.ts', text: 'export const id = Number(record.globalId);', kind: 'typescript' }).includes('data-lossy-identity-coercion')); });
test('does not flag identifiers preserved as strings', () => { assert.ok(!ids({ path: 'Webclient.app/src/data/records.ts', text: 'export const id = String(record.globalId);', kind: 'typescript' }).includes('data-lossy-identity-coercion')); });
test('flags repeated collection growth without an explicit bound', () => { const text = 'items.push(a); items.push(b); items.push(c); items.push(d);'; assert.ok(ids({ path: 'Webclient.app/src/data/cache.ts', text, kind: 'typescript' }).includes('data-unbounded-runtime-collection')); });
test('accepts collection growth with explicit capacity semantics', () => { const text = 'const capacity = 100; items.push(a); items.push(b); items.push(c); items.push(d); if (items.length > capacity) items.shift();'; assert.ok(!ids({ path: 'Webclient.app/src/data/cache.ts', text, kind: 'typescript' }).includes('data-unbounded-runtime-collection')); });
test('flags identity-heavy code without a dedupe signal', () => { const text = Array.from({ length: 12 }, (_, index) => `const id${index} = row.objectId;`).join('\n'); assert.ok(ids({ path: 'Webclient.app/src/data/features.ts', text, kind: 'typescript' }).includes('data-identity-without-dedupe-signal')); });
test('accepts identity-heavy code with explicit Map dedupe', () => { const text = `const byId = new Map();\n${Array.from({ length: 12 }, (_, index) => `byId.set(row.objectId, ${index});`).join('\n')}`; assert.ok(!ids({ path: 'Webclient.app/src/data/features.ts', text, kind: 'typescript' }).includes('data-identity-without-dedupe-signal')); });
test('ignores test fixtures', () => { const text = 'const id = Number(row.globalId); items.push(a); items.push(b); items.push(c); items.push(d);'; assert.equal(ids({ path: 'Webclient.app/src/data/cache.test.ts', text, kind: 'typescript' }).length, 0); });
