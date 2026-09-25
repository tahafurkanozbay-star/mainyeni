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

test('does not report nearby sequential loops as structurally nested work', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/runtime.ts',
      text: `
        for (const item of primary) { consume(item); }
        for (const item of secondary) { consume(item); }
        while (queue.length > 0) { consume(queue.shift()); }
      `,
    },
  ]));
  assert.ok(!ids(section).includes('performance-nested-loop-review'));
});

test('detects nested forEach callbacks without proximity heuristics', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/runtime.ts',
      text: `items.forEach(item => { values.forEach(value => consume(item, value)); });`,
    },
  ]));
  assert.ok(ids(section).includes('performance-nested-loop-review'));
});

test('ignores loop-like text in comments and string literals', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/runtime.ts',
      text: `
        const example = "for (const a of x) { for (const b of y) {} }";
        // for (const a of x) { for (const b of y) {} }
        /* while (ready) { while (pending) {} } */
        for (const item of items) { consume(item); }
      `,
    },
  ]));
  assert.ok(!ids(section).includes('performance-nested-loop-review'));
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


test('flags legacy JavaScript inside the performance instrumentation boundary', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/performance/runtime.js',
      text: 'export const runtime = true;',
    },
    {
      path: 'Webclient.app/src/reportWebVitals.js',
      text: 'export default function report() {}',
    },
  ]));
  assert.ok(ids(section).includes('performance-legacy-javascript-runtime'));
  assert.deepEqual(section.summary.legacyPerformanceJavascriptFiles, [
    'Webclient.app/src/performance/runtime.js',
    'Webclient.app/src/reportWebVitals.js',
  ]);
});

test('flags PerformanceObserver lifecycle imbalance only inside instrumentation files', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/performance/observer.ts',
      text: 'const observer = new PerformanceObserver(() => {}); observer.observe({ type: "resource" });',
    },
    {
      path: 'Webclient.app/src/feature/unrelated.ts',
      text: 'const observer = new PerformanceObserver(() => {});',
    },
  ]));
  assert.ok(ids(section).includes('performance-observer-lifecycle-risk'));
  assert.deepEqual(section.summary.observerLifecycleRiskFiles, [
    'Webclient.app/src/performance/observer.ts',
  ]);
});

test('accepts explicitly disconnected observers', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/platform/performance/monitor.ts',
      text: 'const observer = new PerformanceObserver(() => {}); observer.observe({ type: "resource" }); observer.disconnect();',
    },
  ]));
  assert.equal(ids(section).includes('performance-observer-lifecycle-risk'), false);
  assert.deepEqual(section.summary.observerLifecycleRiskFiles, []);
});

test('flags recurring performance timers without deterministic cleanup', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/performance/poller.ts',
      text: 'const id = setInterval(sample, 1000);',
    },
  ]));
  assert.ok(ids(section).includes('performance-recurring-timer-lifecycle-risk'));
  assert.deepEqual(section.summary.recurringTimerLifecycleRiskFiles, [
    'Webclient.app/src/performance/poller.ts',
  ]);
});

test('accepts balanced recurring timer cleanup', () => {
  const section = auditPerformance(fixtureInventory([
    {
      path: 'Webclient.app/src/performance/poller.ts',
      text: 'const id = setInterval(sample, 1000); clearInterval(id);',
    },
  ]));
  assert.equal(ids(section).includes('performance-recurring-timer-lifecycle-risk'), false);
  assert.deepEqual(section.summary.recurringTimerLifecycleRiskFiles, []);
});
