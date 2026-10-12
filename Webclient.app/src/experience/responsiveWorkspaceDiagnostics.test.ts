import { afterEach, describe, expect, it, vi } from 'vitest';

const diagnostics = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock('../platform/runtime/runtimeDiagnostics', () => ({ runtimeDiagnostics: diagnostics }));
import { createResponsiveWorkspaceRuntime } from './responsiveWorkspace';

const metrics = { width: 1280, height: 800 };
afterEach(() => { vi.restoreAllMocks(); diagnostics.captureError.mockReset(); });

describe('responsive workspace diagnostic isolation', () => {
  it('records both the host failure and its failing error observer while preserving state', () => {
    const hostFailure = new Error('Host observer failed');
    const reporterFailure = new Error('Error observer failed');
    const runtime = createResponsiveWorkspaceRuntime({
      initialMetrics: metrics,
      onChange: () => { throw hostFailure; },
      onError: () => { throw reporterFailure; },
    });
    expect(() => runtime.setPanel('search')).not.toThrow();
    expect(runtime.getSnapshot().state.activePanel).toBe('search');
    expect(diagnostics.captureError).toHaveBeenCalledWith(hostFailure, { source: 'experience.responsive-workspace.observer' }, 'warn');
    expect(diagnostics.captureError).toHaveBeenCalledWith(reporterFailure, { source: 'experience.responsive-workspace.observer' }, 'warn');
    runtime.dispose();
  });

  it('reports a diagnostic failure without exposing its payload or interrupting workspace interaction', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    diagnostics.captureError.mockImplementation(() => { throw new Error('Private reporter payload'); });
    const runtime = createResponsiveWorkspaceRuntime({
      initialMetrics: metrics,
      onChange: () => { throw new Error('Private host payload'); },
    });
    expect(() => runtime.setPanel('layers')).not.toThrow();
    expect(runtime.getSnapshot().state.activePanel).toBe('layers');
    expect(warn).toHaveBeenCalledExactlyOnceWith('Responsive workspace diagnostic reporting failed.');
    runtime.dispose();
  });
});
