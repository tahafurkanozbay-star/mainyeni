import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAsyncResourceLifecycle } from './async-resource-lifecycle-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditAsyncResourceLifecycle(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

test('accepts MutationObserver with deterministic disconnect', () => {
  const result = audit([{
    path: 'Webclient.app/src/ObserverRuntime.ts',
    text: `
      export class ObserverRuntime {
        private observer = new MutationObserver(() => {});
        start(node: Node) { this.observer.observe(node, { childList: true }); }
        dispose() { this.observer.disconnect(); }
      }
    `,
  }]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.observerResources, 1);
});

test('reports MutationObserver without disconnect', () => {
  const result = audit([{
    path: 'Webclient.app/src/ObserverRuntime.ts',
    text: 'export const observer = new MutationObserver(() => {});',
  }]);
  const finding = result.findings.find(item => item.id === 'runtime-observer-without-cleanup');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
});

test('accepts ResizeObserver with disconnect', () => {
  const result = audit([{
    path: 'Webclient.app/src/ResizeRuntime.ts',
    text: `
      export function createRuntime() {
        const observer = new ResizeObserver(() => {});
        return { dispose() { observer.disconnect(); } };
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-observer-without-cleanup'));
});

test('accepts IntersectionObserver with unobserve', () => {
  const result = audit([{
    path: 'Webclient.app/src/IntersectionRuntime.ts',
    text: `
      const observer = new IntersectionObserver(() => {});
      export const release = (node: Element) => observer.unobserve(node);
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-observer-without-cleanup'));
});

test('reports requestAnimationFrame loop without cancellation', () => {
  const result = audit([{
    path: 'Webclient.app/src/AnimationManager.ts',
    text: `
      export class AnimationManager {
        start() { requestAnimationFrame(() => this.start()); }
        dispose() {}
      }
    `,
  }]);
  assert.ok(result.findings.some(item => item.id === 'runtime-animation-frame-without-cleanup'));
});

test('accepts requestAnimationFrame with cancelAnimationFrame', () => {
  const result = audit([{
    path: 'Webclient.app/src/AnimationManager.ts',
    text: `
      export class AnimationManager {
        private frame = 0;
        start() { this.frame = requestAnimationFrame(() => this.start()); }
        dispose() { cancelAnimationFrame(this.frame); }
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-animation-frame-without-cleanup'));
});

test('blocks lifecycle-owned Worker without termination', () => {
  const result = audit([{
    path: 'Webclient.app/src/WorkerRuntime.ts',
    text: `
      export class WorkerRuntime {
        private worker = new Worker(new URL('./worker.ts', import.meta.url));
        dispose() {}
      }
    `,
  }]);
  const finding = result.findings.find(item => item.id === 'runtime-worker-without-cleanup');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('accepts Worker with terminate', () => {
  const result = audit([{
    path: 'Webclient.app/src/WorkerRuntime.ts',
    text: `
      export class WorkerRuntime {
        private worker = new Worker(new URL('./worker.ts', import.meta.url));
        dispose() { this.worker.terminate(); }
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-worker-without-cleanup'));
});

test('accepts SharedWorker port close', () => {
  const result = audit([{
    path: 'Webclient.app/src/SharedRuntime.ts',
    text: `
      const worker = new SharedWorker(new URL('./shared.ts', import.meta.url));
      export const dispose = () => worker.port.close();
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-worker-without-cleanup'));
});

test('reports BroadcastChannel without close', () => {
  const result = audit([{
    path: 'Webclient.app/src/ChannelBridge.ts',
    text: `
      export class ChannelBridge {
        readonly channel = new BroadcastChannel('map-sync');
        dispose() {}
      }
    `,
  }]);
  assert.ok(result.findings.some(item => item.id === 'runtime-broadcast-channel-without-cleanup'));
});

test('accepts BroadcastChannel with close', () => {
  const result = audit([{
    path: 'Webclient.app/src/ChannelBridge.ts',
    text: `
      export class ChannelBridge {
        readonly channel = new BroadcastChannel('map-sync');
        dispose() { this.channel.close(); }
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-broadcast-channel-without-cleanup'));
});

test('blocks lifecycle-owned WebSocket without close', () => {
  const result = audit([{
    path: 'Webclient.app/src/SocketManager.ts',
    text: `
      export class SocketManager {
        private socket = new WebSocket('/events');
        dispose() {}
      }
    `,
  }]);
  const finding = result.findings.find(item => item.id === 'runtime-websocket-without-cleanup');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('accepts WebSocket with close', () => {
  const result = audit([{
    path: 'Webclient.app/src/SocketManager.ts',
    text: `
      export class SocketManager {
        private socket = new WebSocket('/events');
        dispose() { this.socket.close(); }
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-websocket-without-cleanup'));
});

test('blocks lifecycle-owned EventSource without close', () => {
  const result = audit([{
    path: 'Webclient.app/src/EventStreamRuntime.ts',
    text: `
      export class EventStreamRuntime {
        stream = new EventSource('/events');
        dispose() {}
      }
    `,
  }]);
  const finding = result.findings.find(item => item.id === 'runtime-event-source-without-cleanup');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('accepts EventSource with close', () => {
  const result = audit([{
    path: 'Webclient.app/src/EventStreamRuntime.ts',
    text: `
      export class EventStreamRuntime {
        stream = new EventSource('/events');
        dispose() { this.stream.close(); }
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-event-source-without-cleanup'));
});

test('reports AbortController whose signal is unused', () => {
  const result = audit([{
    path: 'Webclient.app/src/QueryRuntime.ts',
    text: `
      export function run() {
        const controller = new AbortController();
        return fetch('/query');
      }
    `,
  }]);
  assert.ok(result.findings.some(item => item.id === 'runtime-abort-controller-signal-unused'));
});

test('reports lifecycle-owned AbortController that is never aborted', () => {
  const result = audit([{
    path: 'Webclient.app/src/QueryRuntime.ts',
    text: `
      export class QueryRuntime {
        controller = new AbortController();
        start() { return fetch('/query', { signal: this.controller.signal }); }
        dispose() {}
      }
    `,
  }]);
  assert.ok(result.findings.some(item => item.id === 'runtime-abort-controller-not-aborted'));
});

test('accepts AbortController signal and abort teardown', () => {
  const result = audit([{
    path: 'Webclient.app/src/QueryRuntime.ts',
    text: `
      export class QueryRuntime {
        controller = new AbortController();
        start() { return fetch('/query', { signal: this.controller.signal }); }
        dispose() { this.controller.abort(); }
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id.startsWith('runtime-abort-controller-')));
});

test('blocks directly async useEffect callback', () => {
  const result = audit([{
    path: 'Webclient.app/src/Panel.tsx',
    text: `
      import { useEffect } from 'react';
      export function Panel() {
        useEffect(async () => { await load(); }, []);
        return <div />;
      }
    `,
  }]);
  const finding = result.findings.find(item => item.id === 'react-async-effect-callback');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('accepts synchronous effect that launches async work and returns cleanup', () => {
  const result = audit([{
    path: 'Webclient.app/src/Panel.tsx',
    text: `
      import { useEffect } from 'react';
      export function Panel() {
        useEffect(() => {
          const controller = new AbortController();
          void load(controller.signal);
          return () => controller.abort();
        }, []);
        return <div />;
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'react-async-effect-callback'));
});

test('reports anonymous addEventListener callback', () => {
  const result = audit([{
    path: 'Webclient.app/src/KeyboardBridge.ts',
    text: `
      export class KeyboardBridge {
        mount() { window.addEventListener('keydown', (event) => this.onKey(event)); }
        dispose() { window.removeEventListener('keydown', this.onKey); }
        onKey = (_event: KeyboardEvent) => {};
      }
    `,
  }]);
  assert.ok(result.findings.some(item => item.id === 'runtime-anonymous-event-listener'));
});

test('does not report stable listener callback', () => {
  const result = audit([{
    path: 'Webclient.app/src/KeyboardBridge.ts',
    text: `
      export class KeyboardBridge {
        mount() { window.addEventListener('keydown', this.onKey); }
        dispose() { window.removeEventListener('keydown', this.onKey); }
        onKey = (_event: KeyboardEvent) => {};
      }
    `,
  }]);
  assert.ok(!result.findings.some(item => item.id === 'runtime-anonymous-event-listener'));
});

test('ignores test files and fixtures', () => {
  const result = audit([
    {
      path: 'Webclient.app/src/Widget.test.tsx',
      text: 'const socket = new WebSocket("/x");',
    },
    {
      path: 'Webclient.app/src/fixtures/legacy.ts',
      text: 'const observer = new MutationObserver(() => {});',
    },
  ]);
  assert.equal(result.summary.files, 0);
  assert.equal(result.findings.length, 0);
});

test('ignores non-runtime tooling files', () => {
  const result = audit([{
    path: 'quality/release/example.mts',
    text: 'const socket = new WebSocket("/x");',
  }]);
  assert.equal(result.summary.files, 0);
});

test('scans admin runtime sources too', () => {
  const result = audit([{
    path: 'Webclient.admin/src/AdminSocketRuntime.ts',
    text: `
      export class AdminSocketRuntime {
        socket = new WebSocket('/admin-events');
        dispose() {}
      }
    `,
  }]);
  assert.equal(result.summary.files, 1);
  assert.ok(result.findings.some(item => item.id === 'runtime-websocket-without-cleanup'));
});

test('caps repeated signals per resource kind', () => {
  const repeated = Array.from({ length: 30 }, () => 'new MutationObserver(() => {});').join('\n');
  const result = audit([{ path: 'Webclient.app/src/Many.ts', text: repeated }]);
  assert.equal(result.summary.observerResources, 12);
});

test('keeps result order deterministic', () => {
  const files: readonly FixtureFileInput[] = [
    { path: 'Webclient.app/src/Z.ts', text: 'new BroadcastChannel("z");' },
    { path: 'Webclient.app/src/A.ts', text: 'new MutationObserver(() => {});' },
  ];
  const left = audit(files);
  const right = audit([...files].reverse());
  assert.deepEqual(
    left.findings.map(item => ({ id: item.id, file: item.location?.file, line: item.location?.line })),
    right.findings.map(item => ({ id: item.id, file: item.location?.file, line: item.location?.line })),
  );
});

test('summarizes transport and scheduler resources separately', () => {
  const result = audit([{
    path: 'Webclient.app/src/MixedRuntime.ts',
    text: `
      export class MixedRuntime {
        observer = new ResizeObserver(() => {});
        socket = new WebSocket('/x');
        channel = new BroadcastChannel('x');
        frame = requestAnimationFrame(() => {});
        dispose() {
          this.observer.disconnect();
          this.socket.close();
          this.channel.close();
          cancelAnimationFrame(this.frame);
        }
      }
    `,
  }]);
  assert.equal(result.summary.observerResources, 1);
  assert.equal(result.summary.transportResources, 2);
  assert.equal(result.summary.schedulerResources, 1);
  assert.equal(result.findings.length, 0);
});
