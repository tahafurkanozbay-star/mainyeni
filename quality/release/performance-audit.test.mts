import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPerformance } from './performance-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function ids(section: ReturnType<typeof auditPerformance>): string[] {
  return section.findings.map(item => item.id);
}

test('ignores filename-based test and spec modules in production performance risk', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/runtime.test.ts',
      text: `
        export function testOnly(items) {
          for (const left of items) {
            for (const right of items) {
              consume(left, right);
            }
          }
        }
      `,
    },
    {
      path: 'Webclient.app/src/runtime.spec.ts',
      text: 'export const huge = [' + '1,'.repeat(6000) + '];',
    },
  ]));
  assert.equal(section.summary.synchronousLoopCandidates, 0);
  assert.equal(section.findings.length, 0);
});

test('ignores test directories and generated web output', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/__tests__/nested.ts',
      text: 'for (const a of x) { for (const b of y) { work(a, b); } }',
    },
    {
      path: 'Webclient.app/build/assets/app.js',
      text: 'for (const a of x) { for (const b of y) { work(a, b); } }',
    },
  ]));
  assert.equal(section.findings.length, 0);
});

test('keeps nested-loop review for production runtime modules', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/runtime.ts',
      text: 'for (const a of x) { for (const b of y) { work(a, b); } }',
    },
  ]));
  assert.ok(ids(section).includes('performance-nested-loop-review'));
});

test('production source still contributes loop and maintainability signals', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/runtime.ts',
      text: Array.from({ length: 20 }, (_, index) =>
        `export const value${index} = items.map(item => item.id);`
      ).join('\n'),
    },
  ]));
  assert.ok(section.summary.synchronousLoopCandidates >= 20);
  assert.equal(section.summary.largestFiles[0]?.file, 'Webclient.app/src/runtime.ts');
});
