import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeDependencyContract,
  collectPackageReferences,
  compareManifestSection,
  isTestSource,
  packageNameFromSpecifier,
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

  test('accepts a coherent dependency contract end to end', () => {
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
