import {
  cleanModuleId,
  findLegacyBrowserEnvironmentReferences,
  legacyEnvironmentGuardPlugin,
  legacyJestCompatibilityPlugin,
  legacyPresentationCleanupPlugin,
  stripLegacyRemotePresentationImports,
} from './sourceTransforms';

const transformHandler = (plugin: ReturnType<typeof legacyEnvironmentGuardPlugin>) => {
  if (typeof plugin.transform !== 'function') throw new Error('Expected transform hook function');
  return plugin.transform;
};

describe('shared source transforms', () => {
  test.each([
    ['/workspace/src/App.js', '/workspace/src/App.js'],
    ['/workspace/src/App.js?import', '/workspace/src/App.js'],
    ['/workspace/src/App.js?v=123#hmr', '/workspace/src/App.js'],
    ['/workspace/src/App.tsx#fragment', '/workspace/src/App.tsx'],
  ])('cleans Vite module id %s', (input, expected) => {
    expect(cleanModuleId(input)).toBe(expected);
  });

  test('finds forbidden browser process.env references while allowing the bounded public URL bridge', () => {
    expect(findLegacyBrowserEnvironmentReferences(`
      const base = process.env.PUBLIC_URL;
      const secret = process.env.REACT_APP_SECRET;
      const endpoint = process.env.REACT_APP_API_URL;
      console.log(process.env.REACT_APP_SECRET);
    `)).toEqual([
      'process.env.REACT_APP_SECRET',
      'process.env.REACT_APP_API_URL',
    ]);
  });

  test('environment guard handles Vite query suffixed source ids', () => {
    const plugin = legacyEnvironmentGuardPlugin();
    const transform = transformHandler(plugin);

    expect(() => transform.call({} as never,
      'const value = process.env.REACT_APP_API_URL;',
      '/workspace/src/config.js?import',
    )).toThrow(/typed runtimeConfig\/import\.meta\.env boundary/i);
  });

  test('environment guard allows the narrow PUBLIC_URL compatibility bridge', async () => {
    const plugin = legacyEnvironmentGuardPlugin();
    const transform = transformHandler(plugin);
    const result = await Promise.resolve(transform.call({} as never,
      'const value = process.env.PUBLIC_URL;',
      '/workspace/src/assets.js?v=1',
    ));
    expect(result).toBeNull();
  });

  test('strips only the unused legacy Mukta remote stylesheet import', () => {
    const css = `@import url('https://fonts.googleapis.com/css?family=Mukta');\nbody { font-family: Arial; }`;
    expect(stripLegacyRemotePresentationImports(css)).toBe('body { font-family: Arial; }');
    expect(stripLegacyRemotePresentationImports('@import url("https://example.com/other.css");'))
      .toBe('@import url("https://example.com/other.css");');
  });

  test('presentation cleanup is bounded to the canonical legacy stylesheet', async () => {
    const plugin = legacyPresentationCleanupPlugin();
    if (typeof plugin.transform !== 'function') throw new Error('Expected transform hook function');
    const css = `@import url('https://fonts.googleapis.com/css?family=Mukta');\nbody { color: black; }`;

    const cleaned = await Promise.resolve(plugin.transform.call({} as never,
      css,
      '/workspace/src/styles.css?direct',
    ));
    expect(cleaned).toEqual({ code: 'body { color: black; }', map: null });

    const untouched = await Promise.resolve(plugin.transform.call({} as never,
      css,
      '/workspace/src/feature.css',
    ));
    expect(untouched).toBeNull();
  });

  test('Jest compatibility bridge is bounded to test files', async () => {
    const plugin = legacyJestCompatibilityPlugin();
    if (typeof plugin.transform !== 'function') throw new Error('Expected transform hook function');

    const testResult = await Promise.resolve(plugin.transform.call({} as never,
      'jest.fn(); jest.spyOn(object, "method");',
      '/workspace/src/example.test.js?import',
    ));
    expect(testResult).toEqual({
      code: 'vi.fn(); vi.spyOn(object, "method");',
      map: null,
    });

    const productionResult = await Promise.resolve(plugin.transform.call({} as never,
      'jest.fn();',
      '/workspace/src/example.js',
    ));
    expect(productionResult).toBeNull();
  });
});
