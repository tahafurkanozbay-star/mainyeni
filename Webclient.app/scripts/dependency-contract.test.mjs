import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeDependencyContract,
  collectDependencyHygieneIssues,
  collectPackageReferences,
  compareManifestSection,
  isTestSource,
  packageNameFromSpecifier,
  validateDependencyHygiene,
  validateDependencyPolicy,
  validateLockfile,
  validateModernToolchain,
  validateSourceDependencies,
  validateVersionSpecifiers,
} from './dependency-contract.mjs';

const manifest = {
  name: 'webclient',
  version: '1.0.0',
  dependencies: {
    react: '^19.3.0',
    'react-dom': '^19.3.0',
    'react-redux': '^9.2.0',
    redux: '^5.0.1',
    bootstrap: '^5.3.8',
  },
  devDependencies: {
    '@testing-library/react': '^16.3.3',
    vite: '^8.3.0',
    vitest: '^5.0.1',
    typescript: '^7.0.2',
  },
  engines: { node: '>=24.0.0', npm: '>=11.0.0' },
};

const directPackageEntry = (version = '1.0.0', extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
  integrity: 'sha512-example',
  license: 'MIT',
  ...extra,
});

const lockfile = {
  lockfileVersion: 3,
  packages: {
    '': {
      name: manifest.name,
      version: manifest.version,
      dependencies: { ...manifest.dependencies },
      devDependencies: { ...manifest.devDependencies },
      engines: { ...manifest.engines },
    },
  },
};

const policy = (exceptions = [], budgets = {}) => ({
  schemaVersion: 1,
  budgets: {
    maxExceptions: 20,
    maxUnusedRuntime: 20,
    maxDeprecatedDirect: 20,
    maxInstallScriptDirect: 20,
    ...budgets,
  },
  exceptions,
});

const exception = (packageName, issues, overrides = {}) => ({
  package: packageName,
  issues,
  owner: 'platform',
  expiresOn: '2099-12-31',
  reason: `Reviewed ${packageName} dependency debt.`,
  ...overrides,
});

describe('dependency contract', () => {
  const packageCases = [
    ['react', 'react'],
    ['react-dom/client', 'react-dom'],
    ['@scope/package/path', '@scope/package'],
    ['./local', null],
    ['../local', null],
    ['/absolute', null],
    ['node:fs', null],
    ['https://cdn.example/module.js', null],
  ];
  for (const [specifier, expected] of packageCases) {
    test(`extracts package root from ${specifier}`, () => {
      assert.equal(packageNameFromSpecifier(specifier), expected);
    });
  }

  test('collects static, side-effect, dynamic and require package imports', () => {
    assert.deepEqual(collectPackageReferences(`
      import React from 'react';
      import 'bootstrap/dist/css/bootstrap.min.css';
      export { createPortal } from 'react-dom';
      const helper = require('@scope/helper/runtime');
      const lazy = import('react-redux');
      const local = import('./local');
    `), [
      '@scope/helper',
      'bootstrap',
      'react',
      'react-dom',
      'react-redux',
    ]);
  });

  test('does not misclassify object require methods as CommonJS package imports', () => {
    assert.deepEqual(collectPackageReferences(`
      const registry = { require() {} };
      registry.require('Missing');
      serviceRegistry.require("AnotherMissing");
      const actual = require('real-package');
    `), ['real-package']);
  });

  const sourceCases = [
    ['src/App.test.js', true],
    ['src/__tests__/App.js', true],
    ['src/setupTests.js', true],
    ['src/App.tsx', false],
  ];
  for (const [path, expected] of sourceCases) {
    test(`classifies test-only source ${path}`, () => {
      assert.equal(isTestSource(path), expected);
    });
  }

  test('detects lockfile manifest drift', () => {
    assert.deepEqual(compareManifestSection('dependencies', {
      react: '^19.3.0',
      redux: '^5.0.1',
    }, {
      react: '^19.2.0',
      orphan: '^1.0.0',
    }), [
      'dependencies: lockfile contains undeclared dependency orphan',
      'dependencies: react specifier differs (^19.3.0 != ^19.2.0)',
      'dependencies: package-lock is missing redux',
    ]);
  });

  test('accepts an exactly synchronized lockfile root', () => {
    assert.deepEqual(validateLockfile(manifest, lockfile), []);
  });

  test('requires lockfile v3 and root metadata', () => {
    assert.deepEqual(validateLockfile(manifest, { lockfileVersion: 2, packages: {} }), [
      'lockfile: expected lockfileVersion 3, received 2',
      'lockfile: root package metadata is missing',
    ]);
  });

  for (const specifier of [
    '*',
    'latest',
    'next',
    'https://example.test/package.tgz',
    'git+https://example.test/repo.git',
    'file:../package',
  ]) {
    test(`rejects non-release dependency specifier ${specifier}`, () => {
      assert.equal(validateVersionSpecifiers({ dependencies: { example: specifier } }).length, 1);
    });
  }

  test('prevents react-scripts from returning after Vite migration', () => {
    assert.match(
      validateVersionSpecifiers({ dependencies: { 'react-scripts': '^5.0.1' } })[0],
      /forbidden by the Vite migration contract/i,
    );
  });

  test('accepts the modern minimum toolchain majors', () => {
    assert.deepEqual(validateModernToolchain(manifest), []);
  });

  test('reports legacy toolchain majors and missing contracts', () => {
    const legacy = {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        react: '^17.0.2',
        'react-redux': '^7.2.0',
      },
      devDependencies: {
        vite: '^6.0.0',
        vitest: '^3.0.0',
        typescript: '^5.9.0',
      },
      engines: { node: '>=20', npm: '>=10' },
    };
    const errors = validateModernToolchain(legacy).join('\n');
    assert.match(errors, /react major 17/i);
    assert.match(errors, /react-redux major 7/i);
    assert.match(errors, /vite major 6/i);
    assert.match(errors, /typescript major 5/i);
    assert.match(errors, /Node engine/i);
    assert.match(errors, /npm engine/i);
  });

  test('requires runtime imports to be production dependencies', () => {
    const result = validateSourceDependencies([
      { path: 'src/App.tsx', references: ['react', '@testing-library/react', 'missing'] },
      { path: 'src/App.test.tsx', references: ['@testing-library/react'] },
    ], manifest);

    assert.deepEqual(result.errors, [
      'src/App.tsx: runtime source imports devDependency @testing-library/react',
      'src/App.tsx: imports undeclared package missing',
    ]);
    assert.deepEqual(result.usedRuntime, ['@testing-library/react', 'missing', 'react']);
    assert.deepEqual(result.usedDevelopment, ['@testing-library/react']);
  });

  test('accepts a coherent dependency contract end to end without an optional debt policy', () => {
    const result = analyzeDependencyContract({
      manifest,
      lockfile,
      inventory: [
        { path: 'src/App.tsx', references: ['react', 'bootstrap'] },
        { path: 'src/App.test.tsx', references: ['react', '@testing-library/react'] },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.runtimePackages, ['bootstrap', 'react']);
  });
});

describe('dependency hygiene policy', () => {
  const hygieneManifest = {
    name: 'webclient',
    version: '1.0.0',
    dependencies: {
      react: '^19.3.0',
      legacy: '^1.0.0',
      installer: '^1.0.0',
    },
    devDependencies: {},
    engines: { node: '>=24.0.0', npm: '>=11.0.0' },
  };

  const hygieneLockfile = {
    lockfileVersion: 3,
    packages: {
      '': {
        name: hygieneManifest.name,
        version: hygieneManifest.version,
        dependencies: { ...hygieneManifest.dependencies },
        devDependencies: {},
        engines: { ...hygieneManifest.engines },
      },
      'node_modules/react': directPackageEntry('19.3.0'),
      'node_modules/legacy': directPackageEntry('1.0.0', { deprecated: 'no longer maintained' }),
      'node_modules/installer': directPackageEntry('1.0.0', { hasInstallScript: true }),
    },
  };

  const source = {
    errors: [],
    usedRuntime: ['react'],
    usedDevelopment: [],
  };

  test('classifies unused, deprecated and install-script direct dependency debt', () => {
    assert.deepEqual(collectDependencyHygieneIssues({
      manifest: hygieneManifest,
      lockfile: hygieneLockfile,
      source,
    }), [
      { package: 'installer', issue: 'install-script-direct' },
      { package: 'installer', issue: 'unused-runtime' },
      { package: 'legacy', issue: 'deprecated-direct' },
      { package: 'legacy', issue: 'unused-runtime' },
    ]);
  });

  test('requires every observed issue to be explicitly reviewed', () => {
    const issues = collectDependencyHygieneIssues({ manifest: hygieneManifest, lockfile: hygieneLockfile, source });
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues,
      policy: policy(),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.equal(result.errors.length, 4);
    assert.match(result.errors.join('\n'), /unreviewed deprecated-direct issue for legacy/);
    assert.match(result.errors.join('\n'), /unreviewed install-script-direct issue for installer/);
  });

  test('accepts exact reviewed debt within budgets', () => {
    const issues = collectDependencyHygieneIssues({ manifest: hygieneManifest, lockfile: hygieneLockfile, source });
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues,
      policy: policy([
        exception('legacy', ['unused-runtime', 'deprecated-direct']),
        exception('installer', ['unused-runtime', 'install-script-direct']),
      ], {
        maxExceptions: 4,
        maxUnusedRuntime: 2,
        maxDeprecatedDirect: 1,
        maxInstallScriptDirect: 1,
      }),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.counts, {
      'deprecated-direct': 1,
      'install-script-direct': 1,
      'unused-runtime': 2,
    });
  });

  test('rejects expired exceptions', () => {
    const issues = [{ package: 'legacy', issue: 'unused-runtime' }];
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues,
      policy: policy([
        exception('legacy', ['unused-runtime'], { expiresOn: '2026-10-04' }),
      ]),
      now: new Date('2026-10-05T12:00:00Z'),
    });

    assert.match(result.errors.join('\n'), /expired on 2026-10-04/);
  });

  test('rejects stale exceptions so the allowlist shrinks with cleanup', () => {
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues: [],
      policy: policy([exception('legacy', ['unused-runtime'])]),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.match(result.errors.join('\n'), /is stale; legacy\/unused-runtime is no longer observed/);
  });

  test('rejects policy entries for non-runtime packages', () => {
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues: [],
      policy: policy([exception('missing', ['unused-runtime'])]),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.match(result.errors.join('\n'), /references non-runtime dependency missing/);
  });

  test('rejects duplicate issue exceptions', () => {
    const issues = [{ package: 'legacy', issue: 'unused-runtime' }];
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues,
      policy: policy([
        exception('legacy', ['unused-runtime']),
        exception('legacy', ['unused-runtime']),
      ]),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.match(result.errors.join('\n'), /duplicates exception legacy\/unused-runtime/);
  });

  test('rejects unknown issue names', () => {
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues: [],
      policy: policy([exception('legacy', ['mystery-risk'])]),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.match(result.errors.join('\n'), /uses unknown issue mystery-risk/);
  });

  test('rejects invalid or missing policy metadata', () => {
    const issues = [{ package: 'legacy', issue: 'unused-runtime' }];
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues,
      policy: {
        schemaVersion: 2,
        budgets: {
          maxExceptions: -1,
          maxUnusedRuntime: 'many',
          maxDeprecatedDirect: 0,
          maxInstallScriptDirect: 0,
        },
        exceptions: [{
          package: 'legacy',
          issues: ['unused-runtime'],
          owner: '',
          reason: '',
          expiresOn: '05/10/2026',
        }],
      },
      now: new Date('2026-10-05T00:00:00Z'),
    });

    const errors = result.errors.join('\n');
    assert.match(errors, /expected schemaVersion 1/);
    assert.match(errors, /owner is required/);
    assert.match(errors, /reason is required/);
    assert.match(errors, /expiresOn must use YYYY-MM-DD/);
    assert.match(errors, /maxExceptions must be a non-negative integer/);
    assert.match(errors, /maxUnusedRuntime must be a non-negative integer/);
  });

  test('rejects budget growth even when new debt is explicitly allowlisted', () => {
    const issues = [
      { package: 'legacy', issue: 'unused-runtime' },
      { package: 'installer', issue: 'unused-runtime' },
    ];
    const result = validateDependencyPolicy({
      manifest: hygieneManifest,
      issues,
      policy: policy([
        exception('legacy', ['unused-runtime']),
        exception('installer', ['unused-runtime']),
      ], {
        maxExceptions: 1,
        maxUnusedRuntime: 1,
      }),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    const errors = result.errors.join('\n');
    assert.match(errors, /2 exception issues exceed maxExceptions budget 1/);
    assert.match(errors, /2 unused-runtime issues exceed maxUnusedRuntime budget 1/);
  });

  test('requires concrete direct lockfile provenance and integrity metadata', () => {
    const brokenLockfile = structuredClone(hygieneLockfile);
    delete brokenLockfile.packages['node_modules/legacy'].integrity;
    brokenLockfile.packages['node_modules/installer'].resolved = '';

    const result = validateDependencyHygiene({
      manifest: hygieneManifest,
      lockfile: brokenLockfile,
      source,
      policy: policy([
        exception('legacy', ['unused-runtime', 'deprecated-direct']),
        exception('installer', ['unused-runtime', 'install-script-direct']),
      ]),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    const errors = result.errors.join('\n');
    assert.match(errors, /legacy is missing integrity metadata/);
    assert.match(errors, /installer is missing registry provenance/);
  });

  test('reports missing direct package lock entries', () => {
    const brokenLockfile = structuredClone(hygieneLockfile);
    delete brokenLockfile.packages['node_modules/legacy'];
    const result = validateDependencyHygiene({
      manifest: hygieneManifest,
      lockfile: brokenLockfile,
      source,
      policy: policy([
        exception('legacy', ['unused-runtime']),
        exception('installer', ['unused-runtime', 'install-script-direct']),
      ]),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.match(result.errors.join('\n'), /dependencies package legacy has no resolved package entry/);
  });

  test('integrates reviewed hygiene debt into the end-to-end contract', () => {
    const integratedManifest = {
      ...manifest,
      dependencies: { ...manifest.dependencies, legacy: '^1.0.0' },
    };
    const integratedLock = structuredClone(lockfile);
    integratedLock.packages[''].dependencies.legacy = '^1.0.0';
    for (const packageName of Object.keys(integratedManifest.dependencies)) {
      integratedLock.packages[`node_modules/${packageName}`] = directPackageEntry(
        packageName === 'react' || packageName === 'react-dom' ? '19.3.0' : '1.0.0',
      );
    }
    for (const packageName of Object.keys(integratedManifest.devDependencies)) {
      integratedLock.packages[`node_modules/${packageName}`] = directPackageEntry('1.0.0');
    }
    integratedLock.packages['node_modules/legacy'].deprecated = 'legacy';

    const inventory = [
      { path: 'src/App.tsx', references: ['react', 'react-dom', 'react-redux', 'redux', 'bootstrap'] },
    ];
    const result = analyzeDependencyContract({
      manifest: integratedManifest,
      lockfile: integratedLock,
      inventory,
      policy: policy([
        exception('legacy', ['unused-runtime', 'deprecated-direct']),
      ], {
        maxExceptions: 2,
        maxUnusedRuntime: 1,
        maxDeprecatedDirect: 1,
        maxInstallScriptDirect: 0,
      }),
      now: new Date('2026-10-05T00:00:00Z'),
    });

    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.hygieneCounts, {
      'deprecated-direct': 1,
      'install-script-direct': 0,
      'unused-runtime': 1,
    });
  });
});
