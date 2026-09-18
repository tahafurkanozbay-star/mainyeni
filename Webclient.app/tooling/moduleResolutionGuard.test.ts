import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  describeModuleResolutionAmbiguity,
  findExistingRelativeImportCandidates,
  hasExplicitModuleExtension,
  hasTypedJavascriptCollision,
  isRelativeModuleSpecifier,
  isStrictTypedDomainAmbiguity,
  moduleCandidatePaths,
  moduleResolutionGuardPlugin,
} from './moduleResolutionGuard';

const fixture = (): string => mkdtempSync(join(tmpdir(), 'kent-module-resolution-'));

const write = (root: string, relativePath: string, content = 'export {};'): string => {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
};

describe('module resolution guard', () => {
  test.each([
    ['./runtime', true],
    ['../runtime', true],
    ['.', true],
    ['react', false],
    ['@arcgis/core/Map.js', false],
    ['/absolute/path', false],
  ])('classifies relative module specifier %s', (source, expected) => {
    expect(isRelativeModuleSpecifier(source)).toBe(expected);
  });

  test.each([
    ['./runtime.ts', true],
    ['./runtime.js', true],
    ['./runtime.json', true],
    ['./runtime', false],
    ['../runtime?raw', false],
  ])('classifies explicit extension for %s', (source, expected) => {
    expect(hasExplicitModuleExtension(source)).toBe(expected);
  });

  test('builds direct and index candidates deterministically', () => {
    const candidates = moduleCandidatePaths(
      './runtime',
      '/workspace/Webclient.app/src/app.ts',
      ['.ts', '.js'],
    );
    expect(candidates.map((candidate) => [
      candidate.path.replaceAll('\\', '/'),
      candidate.extension,
      candidate.indexModule,
      candidate.typed,
    ])).toEqual([
      ['/workspace/Webclient.app/src/runtime.ts', '.ts', false, true],
      ['/workspace/Webclient.app/src/runtime.js', '.js', false, false],
      ['/workspace/Webclient.app/src/runtime/index.ts', '.ts', true, true],
      ['/workspace/Webclient.app/src/runtime/index.js', '.js', true, false],
    ]);
  });

  test('finds one canonical typed implementation', () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/app.ts');
      write(root, 'Webclient.app/src/runtime.ts');
      const candidates = findExistingRelativeImportCandidates('./runtime', importer);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.typed).toBe(true);
      expect(candidates[0]?.path.endsWith('runtime.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects TypeScript shadowed by JavaScript', () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/app.ts');
      write(root, 'Webclient.app/src/runtime.ts');
      write(root, 'Webclient.app/src/runtime.js');
      const candidates = findExistingRelativeImportCandidates('./runtime', importer);
      expect(candidates).toHaveLength(2);
      expect(hasTypedJavascriptCollision(candidates)).toBe(true);
      expect(describeModuleResolutionAmbiguity('./runtime', importer, candidates))
        .toMatch(/JavaScript\/TypeScript shadow pair/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects direct versus index ambiguity', () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/app.ts');
      write(root, 'Webclient.app/src/runtime.ts');
      write(root, 'Webclient.app/src/runtime/index.ts');
      const candidates = findExistingRelativeImportCandidates('./runtime', importer);
      expect(candidates).toHaveLength(2);
      expect(candidates.some((candidate) => candidate.indexModule)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not inspect explicit file extensions', () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/app.ts');
      write(root, 'Webclient.app/src/runtime.ts');
      write(root, 'Webclient.app/src/runtime.js');
      expect(findExistingRelativeImportCandidates('./runtime.ts', importer)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('plugin returns null for one candidate', async () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/app.ts');
      write(root, 'Webclient.app/src/runtime.ts');
      const plugin = moduleResolutionGuardPlugin();
      if (typeof plugin.resolveId !== 'function') throw new Error('resolveId hook required');
      const result = await Promise.resolve(
        plugin.resolveId.call({ error: (message: unknown) => { throw new Error(String(message)); } } as never, './runtime', importer),
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('plugin fails closed for ambiguous candidates in a strict typed domain', async () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/App.tsx');
      write(root, 'Webclient.app/src/platform/runtime.ts');
      write(root, 'Webclient.app/src/platform/runtime.js');
      const plugin = moduleResolutionGuardPlugin();
      if (typeof plugin.resolveId !== 'function') throw new Error('resolveId hook required');
      await expect(Promise.resolve().then(() =>
        plugin.resolveId.call(
          { error: (message: unknown) => { throw new Error(String(message)); } } as never,
          './platform/runtime',
          importer,
        ),
      )).rejects.toThrow(/Ambiguous extensionless module resolution/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('staged guard does not hard-block legacy experience shadow pairs', async () => {
    const root = fixture();
    try {
      const importer = write(root, 'Webclient.app/src/App.tsx');
      write(root, 'Webclient.app/src/Components/Common/ExperienceWorkspace.tsx');
      write(root, 'Webclient.app/src/Components/Common/ExperienceWorkspace.js');
      const candidates = findExistingRelativeImportCandidates(
        './Components/Common/ExperienceWorkspace',
        importer,
      );
      expect(candidates).toHaveLength(2);
      expect(hasTypedJavascriptCollision(candidates)).toBe(true);
      expect(isStrictTypedDomainAmbiguity(candidates)).toBe(false);

      const plugin = moduleResolutionGuardPlugin();
      if (typeof plugin.resolveId !== 'function') throw new Error('resolveId hook required');
      const context = { error: (message: unknown) => { throw new Error(String(message)); } } as never;
      await expect(Promise.resolve(plugin.resolveId.call(
        context,
        './Components/Common/ExperienceWorkspace',
        importer,
      ))).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('strict typed-domain ambiguity is identified from candidate paths', () => {
    const candidates = moduleCandidatePaths(
      './platform/runtime',
      '/workspace/Webclient.app/src/App.tsx',
      ['.ts', '.js'],
    );
    expect(isStrictTypedDomainAmbiguity(candidates)).toBe(true);
  });

  test('plugin ignores dependency imports and files outside Webclient source boundary', async () => {
    const plugin = moduleResolutionGuardPlugin();
    if (typeof plugin.resolveId !== 'function') throw new Error('resolveId hook required');
    const context = { error: (message: unknown) => { throw new Error(String(message)); } } as never;
    await expect(Promise.resolve(plugin.resolveId.call(context, 'react', '/workspace/Webclient.app/src/app.ts')))
      .resolves.toBeNull();
    await expect(Promise.resolve(plugin.resolveId.call(context, './runtime', '/workspace/tools/audit.mjs')))
      .resolves.toBeNull();
  });

  test('custom existence function makes pure resolution tests deterministic', () => {
    const importer = '/workspace/Webclient.app/src/app.ts';
    const candidates = findExistingRelativeImportCandidates('./runtime', importer, {
      extensions: ['.ts', '.js'],
      exists: (path) => path.endsWith('runtime.js'),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.extension).toBe('.js');
  });
});
