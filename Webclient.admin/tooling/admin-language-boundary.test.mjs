import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditAdminLanguageBoundary,
  formatAuditReport,
} from './admin-language-boundary.mjs';

const basePackage = () => ({
  name: 'fixture-admin',
  private: true,
  type: 'module',
  scripts: {
    build: 'vite build',
    typecheck: 'tsc --noEmit -p tsconfig.json',
    'typecheck:strict': 'tsc --noEmit -p tsconfig.strict.json',
  },
  dependencies: {
    react: '19.3.0',
    'react-dom': '19.3.0',
    'react-router': '8.4.0',
  },
  devDependencies: {
    vite: '8.3.0',
    typescript: '7.0.2',
    vitest: '5.0.1',
  },
  engines: {
    node: '>=24.0.0',
  },
});

const baseTsconfig = () => ({
  compilerOptions: {
    allowJs: false,
    moduleResolution: 'Bundler',
    jsx: 'react-jsx',
  },
  include: [
    'src/**/*.ts',
    'src/**/*.tsx',
  ],
});

const baseStrictTsconfig = () => ({
  extends: './tsconfig.json',
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noCheck: false,
  },
  include: [
    'src/runtime/**/*.ts',
  ],
});

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-language-boundary-'));
  fs.mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'main.tsx'),
    "import React from 'react';\nexport const App = () => <main>ok</main>;\n",
  );
  fs.writeFileSync(
    path.join(root, 'src', 'runtime', 'environment.ts'),
    "export const api = '/api';\n",
  );
  fs.writeFileSync(path.join(root, '.env.example'), 'VITE_API_URL=/api\nVITE_APP_VERSION=dev\n');
  writeJson(path.join(root, 'package.json'), basePackage());
  writeJson(path.join(root, 'tsconfig.json'), baseTsconfig());
  writeJson(path.join(root, 'tsconfig.strict.json'), baseStrictTsconfig());
  return root;
};

const withFixture = (callback) => {
  const root = createFixture();
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const violationIds = (report) => new Set(report.violations.map((item) => item.id));

test('accepts a modern TypeScript, Vite, React 19 and Router 8 fixture', () => {
  withFixture((root) => {
    const report = auditAdminLanguageBoundary(root);
    assert.equal(report.ok, true);
    assert.equal(report.violations.length, 0);
    assert.equal(report.typedFiles, 2);
    assert.equal(report.sourceFiles, 2);
  });
});

test('rejects JavaScript-family files inside production src', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, 'src', 'legacy.js'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'legacy.jsx'), 'export const value = <div />;\n');
    fs.writeFileSync(path.join(root, 'src', 'legacy.mjs'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'legacy.cjs'), 'module.exports = 1;\n');

    const report = auditAdminLanguageBoundary(root);
    const legacy = report.violations.filter((item) => item.id === 'legacy-source-extension');
    assert.equal(report.ok, false);
    assert.equal(legacy.length, 4);
  });
});

test('rejects CRA process.env access', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'runtime', 'bad.ts'),
      "export const endpoint = process.env.REACT_APP_API_URL;\n",
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('cra-env-prefix'));
  });
});

test('rejects react-scripts references in source', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'runtime', 'bad.ts'),
      "export const legacyBuild = 'react-scripts build';\n",
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('cra-react-scripts'));
  });
});

test('rejects legacy ReactDOM.render calls', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'legacy-render.tsx'),
      "ReactDOM.render(<main />, document.getElementById('root'));\n",
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('legacy-reactdom-render'));
  });
});

test('rejects legacy React Router Switch syntax', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'legacy-router.tsx'),
      'export const Routes = () => <Switch><div /></Switch>;\n',
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('legacy-router-switch'));
  });
});

test('rejects legacy React Router component props', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'legacy-route.tsx'),
      'export const RouteConfig = () => <Route path="/" component={Home} />;\n',
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('legacy-router-component-prop'));
  });
});

test('rejects CommonJS require in source', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'legacy-commonjs.ts'),
      "const helper = require('./helper');\nexport { helper };\n",
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('commonjs-require'));
  });
});

test('rejects CommonJS exports in source', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'legacy-exports.ts'),
      'module.exports = { value: 1 };\n',
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('commonjs-exports'));
  });
});

test('rejects react-scripts dependency resurrection', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.devDependencies['react-scripts'] = '5.0.1';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('react-scripts-dependency'));
  });
});

test('requires Vite production build script', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.scripts.build = 'webpack --mode production';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('vite-build-script'));
  });
});

test('requires explicit normal and strict TypeScript checks', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.scripts.typecheck = 'echo skipped';
    manifest.scripts['typecheck:strict'] = 'echo skipped';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    const ids = violationIds(report);
    assert.ok(ids.has('typescript-check-script'));
    assert.ok(ids.has('strict-typescript-check-script'));
  });
});

test('requires React 19 or newer', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.dependencies.react = '18.3.1';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('modern-toolchain-version'));
  });
});

test('requires React Router 8 or newer', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.dependencies['react-router'] = '7.9.0';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('modern-toolchain-version'));
  });
});

test('requires Vite 8 or newer', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.devDependencies.vite = '7.1.0';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('modern-toolchain-version'));
  });
});

test('requires TypeScript 7 or newer', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.devDependencies.typescript = '6.0.0';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('modern-toolchain-version'));
  });
});

test('requires Vitest 5 or newer', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.devDependencies.vitest = '4.0.0';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('modern-toolchain-version'));
  });
});

test('requires Node 24 or newer runtime contract', () => {
  withFixture((root) => {
    const manifest = basePackage();
    manifest.engines.node = '>=22.0.0';
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('node-runtime-contract'));
  });
});

test('requires ESM package mode', () => {
  withFixture((root) => {
    const manifest = basePackage();
    delete manifest.type;
    writeJson(path.join(root, 'package.json'), manifest);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('esm-package-contract'));
  });
});

test('requires allowJs=false', () => {
  withFixture((root) => {
    const config = baseTsconfig();
    config.compilerOptions.allowJs = true;
    writeJson(path.join(root, 'tsconfig.json'), config);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('allow-js-disabled'));
  });
});

test('requires Bundler module resolution', () => {
  withFixture((root) => {
    const config = baseTsconfig();
    config.compilerOptions.moduleResolution = 'NodeNext';
    writeJson(path.join(root, 'tsconfig.json'), config);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('bundler-module-resolution'));
  });
});

test('requires modern react-jsx transform', () => {
  withFixture((root) => {
    const config = baseTsconfig();
    config.compilerOptions.jsx = 'react';
    writeJson(path.join(root, 'tsconfig.json'), config);

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('react-jsx-transform'));
  });
});

test('requires TypeScript and TSX include globs', () => {
  withFixture((root) => {
    const config = baseTsconfig();
    config.include = ['src/runtime/environment.ts'];
    writeJson(path.join(root, 'tsconfig.json'), config);

    const report = auditAdminLanguageBoundary(root);
    const ids = report.violations
      .filter((item) => item.id === 'typescript-include' || item.id === 'tsx-include')
      .map((item) => item.id)
      .sort();

    assert.deepEqual(ids, ['tsx-include', 'typescript-include']);
  });
});

test('requires strict compiler flags in strict boundary config', () => {
  withFixture((root) => {
    const config = baseStrictTsconfig();
    config.compilerOptions.strict = false;
    config.compilerOptions.noUncheckedIndexedAccess = false;
    config.compilerOptions.exactOptionalPropertyTypes = false;
    config.compilerOptions.noCheck = true;
    writeJson(path.join(root, 'tsconfig.strict.json'), config);

    const report = auditAdminLanguageBoundary(root);
    const ids = violationIds(report);
    assert.ok(ids.has('strict-compiler-contract'));
    assert.ok(ids.has('strict-no-check-disabled'));
  });
});

test('requires same-origin API default in tracked environment example', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, '.env.example'), 'VITE_API_URL=https://example.com/api\n');

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('same-origin-api-default'));
  });
});

test('rejects secret-bearing tracked environment keys', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, '.env.example'),
      'VITE_API_URL=/api\n' + ['VITE', 'CLIENT', 'SECRET'].join('_') + '=do-not-track\n',
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('secret-env-placeholder'));
  });
});

test('rejects CRA environment variables in tracked environment example', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, '.env.example'),
      'VITE_API_URL=/api\nREACT_APP_API_URL=/api\n',
    );

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('legacy-cra-env-example'));
  });
});

test('reports missing source directory as a deterministic failure', () => {
  withFixture((root) => {
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });

    const report = auditAdminLanguageBoundary(root);
    assert.equal(report.ok, false);
    assert.ok(violationIds(report).has('missing-src'));
    assert.equal(report.typedFiles, 0);
  });
});

test('reports missing environment example as a deterministic failure', () => {
  withFixture((root) => {
    fs.rmSync(path.join(root, '.env.example'));

    const report = auditAdminLanguageBoundary(root);
    assert.ok(violationIds(report).has('missing-env-example'));
  });
});

test('formats a stable success report', () => {
  withFixture((root) => {
    const report = auditAdminLanguageBoundary(root);
    const text = formatAuditReport(report);

    assert.match(text, /Admin language boundary/u);
    assert.match(text, /typedFiles=2/u);
    assert.match(text, /sourceFiles=2/u);
    assert.match(text, /violations=0/u);
  });
});

test('formats violation identifiers and file paths', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, 'src', 'legacy.js'), 'module.exports = 1;\n');
    const report = auditAdminLanguageBoundary(root);
    const text = formatAuditReport(report);

    assert.match(text, /legacy-source-extension/u);
    assert.match(text, /src\/legacy\.js/u);
    assert.match(text, /violations=1/u);
  });
});
