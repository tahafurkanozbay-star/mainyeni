import {
  normalizeRepositoryPath,
  type FileKind,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { classifyFile, countLines } from './inventory.mts';

export interface FixtureFileInput {
  readonly path: string;
  readonly text: string;
  readonly kind?: FileKind;
}

export function fixtureFile(input: FixtureFileInput, root = '/repo'): SourceFile {
  const repositoryPath = normalizeRepositoryPath(input.path);
  return {
    absolutePath: `${root}/${repositoryPath}`,
    repositoryPath,
    extension: repositoryPath.includes('.') ? `.${repositoryPath.split('.').at(-1) ?? ''}` : '',
    kind: input.kind ?? classifyFile(repositoryPath),
    bytes: Buffer.byteLength(input.text, 'utf8'),
    lines: countLines(input.text),
    text: input.text,
  };
}

export function fixtureInventory(
  inputs: readonly FixtureFileInput[],
  root = '/repo',
): RepositoryInventory {
  const files = inputs.map(input => fixtureFile(input, root));
  const stats = new Map<FileKind, { files: number; lines: number; bytes: number }>();
  for (const file of files) {
    const bucket = stats.get(file.kind) ?? { files: 0, lines: 0, bytes: 0 };
    bucket.files += 1;
    bucket.lines += file.lines;
    bucket.bytes += file.bytes;
    stats.set(file.kind, bucket);
  }
  return {
    root,
    files,
    ignoredDirectories: [],
    languageStats: [...stats.entries()].map(([kind, value]) => ({ kind, ...value })),
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-09-16T00:00:00.000Z',
  };
}

export function webManifest(overrides: Record<string, string> = {}): FixtureFileInput {
  return {
    path: 'Webclient.app/package.json',
    text: JSON.stringify({
      name: 'webclient',
      version: '1.0.0',
      dependencies: {
        react: '^17.0.1',
        'react-dom': '^17.0.1',
        'react-scripts': '^4.0.3',
        axios: '^0.21.1',
        'crypto-js': '^4.0.0',
        jspdf: '^2.4.0',
        ...overrides,
      },
      devDependencies: {},
      scripts: { build: 'react-scripts build', test: 'react-scripts test' },
    }, null, 2),
  };
}

export function webLock(dependencies: Record<string, string>): FixtureFileInput {
  return {
    path: 'Webclient.app/package-lock.json',
    text: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies },
      },
    }, null, 2),
  };
}

export function directoryBuildProps(nullable = 'disable'): FixtureFileInput {
  return {
    path: 'Directory.Build.props',
    text: `<Project>\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n    <LangVersion>latest</LangVersion>\n    <Nullable>${nullable}</Nullable>\n  </PropertyGroup>\n</Project>\n`,
  };
}

export function minimalIconRegistry(rows?: unknown[]): FixtureFileInput {
  return {
    path: 'Webclient.app/src/gis-engine/iconRegistry.json',
    text: JSON.stringify(rows ?? [
      { id: 'park', type: 'park', category: 'Parklar', aliases: ['parklar'], icon: 'images/park.svg' },
      { id: 'default', type: 'default', category: 'default', aliases: ['unknown'], icon: 'images/default.svg' },
    ], null, 2),
  };
}

export function requiredGisRuntimeFiles(): FixtureFileInput[] {
  return [
    'iconResolver.js',
    'iconPresentation.js',
    'serviceRegistry.js',
    'serviceCatalog.js',
    'layerRuntime.js',
    'layerFactory.js',
    'layerOwnership.js',
    'spatialEngine.js',
    'sceneRuntime.js',
    'identifyRuntime.js',
    'measurementRuntime.js',
    'queryRuntime.js',
  ].map(name => ({
    path: `Webclient.app/src/gis-engine/${name}`,
    text: name === 'serviceRegistry.js'
      ? "export const service = 'FeatureServer'; export const timeoutMs = 1000;"
      : name === 'sceneRuntime.js'
        ? "export const createScene = () => 'SceneView';"
        : 'export const runtime = true;\n',
  }));
}

export function requiredTestFiles(): FixtureFileInput[] {
  return [
    'Webclient.app/src/gis-engine/iconRegistry.test.js',
    'Webclient.app/src/gis-engine/layerRuntime.test.js',
    'Webclient.app/src/gis-engine/layerFactory.test.js',
    'Webclient.app/src/gis-engine/layerOwnership.test.js',
    'Webclient.app/src/gis-engine/sceneRuntime.test.js',
    'Webclient.app/src/gis-engine/identifyRuntime.test.js',
    'Webclient.app/src/gis-engine/measurementRuntime.test.js',
    'Webclient.app/src/Toolbox/GisQueryHelper.test.js',
    'Webclient.app/src/Toolbox/DataIntegrityHelper.test.js',
    'Webclient.app/src/Toolbox/RecordSchemaRuntime.test.js',
    'Webclient.app/src/Toolbox/AddressSearchRuntime.test.js',
    'Webclient.app/src/platform/bootstrap/bootstrapCore.test.js',
    'Webclient.app/src/platform/platform.test.js',
    'Webclient.app/src/Components/Query/_Common/QueryInteractionRuntime.test.js',
    'Webclient.app/src/Components/Query/_Common/ManagedFastAccessQueryWindow.test.js',
    'Webclient.app/src/Business/ConfigurationBusiness.test.js',
    'Webclient.app/src/Business/LoggingBusiness.test.js',
    'Api.Core.Tests/PlatformResilienceTests.cs',
  ].map(path => ({ path, text: 'test("contract", () => {});\n' }));
}

export function fullFixtureInventory(extra: readonly FixtureFileInput[] = []): RepositoryInventory {
  return fixtureInventory([
    webManifest(),
    directoryBuildProps(),
    minimalIconRegistry(),
    ...requiredGisRuntimeFiles(),
    ...requiredTestFiles(),
    ...extra,
  ]);
}

declare const Buffer: {
  byteLength(value: string, encoding: string): number;
};
