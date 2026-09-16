import {
  cleanModuleId,
  findLegacyBrowserEnvironmentReferences,
  isLegacyJavascriptSource,
  legacyEnvironmentGuardPlugin,
  legacyJestCompatibilityPlugin,
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

  test.each([
    ['/workspace/src/App.js', true],
    ['/workspace/src/App.js?import', true],
    ['/workspace/src/App.jsx', false],
    ['/workspace/src/App.ts', false],
    ['/workspace/scripts/build.js', false],
  ])('classifies legacy JavaScript source %s', (input, expected) => {
    expect(isLegacyJavascriptSource(input)).toBe(expected);
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
