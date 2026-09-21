import { createAccessibilityPreferencesRuntime } from './accessibilityPreferences';
import { createResponsiveWorkspaceRuntime } from './responsiveWorkspace';

describe('experience observer error boundaries', () => {
  test('accessibility preference observers report failures without blocking healthy observers', () => {
    const listeners = new Map<string, (event: MediaQueryListEvent) => void>();
    const media = new Map<string, { matches: boolean }>();
    const matchMedia = (query: string): MediaQueryList => {
      const state = media.get(query) ?? { matches: false };
      media.set(query, state);
      return {
        get matches() { return state.matches; },
        media: query,
        onchange: null,
        addEventListener: (_type, listener) => {
          if (typeof listener === 'function') listeners.set(query, listener as (event: MediaQueryListEvent) => void);
        },
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      } as MediaQueryList;
    };
    const errors: unknown[] = [];
    const runtime = createAccessibilityPreferencesRuntime({
      window: { matchMedia, document } as unknown as Window,
      reflectToDocument: false,
      onObserverError: error => errors.push(error),
    });
    let healthyCalls = 0;
    runtime.subscribe(() => { throw new Error('observer failed'); });
    runtime.subscribe(() => { healthyCalls += 1; });
    const query = '(prefers-reduced-motion: reduce)';
    const state = media.get(query);
    if (!state) throw new Error('expected media query');
    state.matches = true;
    listeners.get(query)?.({ matches: true, media: query } as MediaQueryListEvent);
    expect(errors).toHaveLength(1);
    expect(healthyCalls).toBe(1);
    expect(runtime.snapshot.reducedMotion).toBe(true);
    runtime.dispose();
  });

  test('responsive workspace reports listener and onChange failures while preserving state', () => {
    const errors: unknown[] = [];
    const runtime = createResponsiveWorkspaceRuntime({
      initialMetrics: { width: 1440, height: 900, hover: true },
      onError: error => errors.push(error),
      onChange: () => { throw new Error('onChange failed'); },
    });
    runtime.subscribe(() => { throw new Error('listener failed'); });
    runtime.setPanel('layers');
    expect(errors).toHaveLength(2);
    expect(runtime.getSnapshot().state.activePanel).toBe('layers');
    runtime.dispose();
  });

  test('responsive workspace keeps notifying healthy listeners after a peer fails', () => {
    const errors: unknown[] = [];
    const runtime = createResponsiveWorkspaceRuntime({
      initialMetrics: { width: 900, height: 700 },
      onError: error => errors.push(error),
    });
    let healthyCalls = 0;
    runtime.subscribe(() => { throw new Error('listener failed'); });
    runtime.subscribe(() => { healthyCalls += 1; });
    runtime.setMapMode('3d');
    expect(errors).toHaveLength(1);
    expect(healthyCalls).toBe(1);
    expect(runtime.getSnapshot().state.mapMode).toBe('3d');
    runtime.dispose();
  });
});
