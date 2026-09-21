import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditTypedSourceBoundary } from './typed-source-boundary.mjs';

const write = async (root, relative, source = '') => {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, 'utf8');
};

const withFixture = async (callback) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-source-boundary-'));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('passes a fully typed application source tree', async () =>
  withFixture(async (root) => {
    await write(root, 'Webclient.app/src/platform/http/runtime.test.ts', 'test("typed", () => { vi.fn(); });');
    await write(root, 'Webclient.app/src/experience/accessibilityRuntime.test.ts', 'test("typed experience", () => {});');

    const report = await auditTypedSourceBoundary(root);

    assert.equal(report.passed, true);
    assert.equal(report.summary.javascriptFiles, 0);
    assert.equal(report.summary.transitionalJavascriptFiles, 0);
    assert.equal(report.summary.violations, 0);
  }));

test('rejects Business and GIS JavaScript after their production cutovers', async () =>
  withFixture(async (root) => {
    await write(root, 'Webclient.app/src/Business/LegacyBusiness.js', 'export const value = 1;');
    await write(root, 'Webclient.app/src/Toolbox/GisGraphicsHelper.js', 'export const value = 1;');

    const report = await auditTypedSourceBoundary(root);

    assert.equal(report.passed, false);
    assert.deepEqual(
      report.findings.map(({ code, file }) => ({ code, file })),
      [
        {
          code: 'unapproved-javascript-source',
          file: 'Webclient.app/src/Business/LegacyBusiness.js',
        },
        {
          code: 'unapproved-javascript-source',
          file: 'Webclient.app/src/Toolbox/GisGraphicsHelper.js',
        },
      ],
    );
  }));

test('rejects JavaScript reintroduction outside bounded ownership', async () =>
  withFixture(async (root) => {
    await write(root, 'Webclient.app/src/Store/Managers/NewManager.js', 'export default {};');

    const report = await auditTypedSourceBoundary(root);

    assert.equal(report.passed, false);
    assert.deepEqual(
      report.findings.map(({ code, file }) => ({ code, file })),
      [{
        code: 'unapproved-javascript-source',
        file: 'Webclient.app/src/Store/Managers/NewManager.js',
      }],
    );
  }));

test('rejects legacy shadow modules even inside otherwise ignored Business ownership', async () =>
  withFixture(async (root) => {
    await write(root, 'Webclient.app/src/Business/Query.legacy.js', 'export const legacy = true;');

    const report = await auditTypedSourceBoundary(root);

    assert.equal(report.passed, false);
    assert.equal(report.findings[0]?.code, 'legacy-shadow-source');
  }));

test('rejects Jest namespace drift in TypeScript tests', async () =>
  withFixture(async (root) => {
    await write(
      root,
      'Webclient.app/src/platform/http/retryPolicy.test.ts',
      'test("legacy", () => { jest.fn(); });',
    );

    const report = await auditTypedSourceBoundary(root);

    assert.equal(report.passed, false);
    assert.equal(report.findings[0]?.code, 'jest-namespace-in-typescript');
  }));

test('does not treat plain TypeScript production modules as test sources', async () =>
  withFixture(async (root) => {
    await write(root, 'Webclient.app/src/platform/http/client.ts', 'export const text = "jest.fn()";');

    const report = await auditTypedSourceBoundary(root);

    assert.equal(report.passed, true);
    assert.equal(report.summary.typedTestFiles, 0);
  }));

test('rejects formerly transitional Platform and Experience JavaScript paths', async () =>
  withFixture(async (root) => {
    await write(
      root,
      'Webclient.app/src/platform/http/retryPolicy.test.js',
      'test("legacy platform drift", () => {});',
    );
    await write(
      root,
      'Webclient.app/src/experience/accessibilityRuntime.test.js',
      'test("legacy experience drift", () => {});',
    );

    const report = await auditTypedSourceBoundary(root);
    assert.equal(report.passed, false);
    assert.equal(report.summary.javascriptFiles, 2);
    assert.equal(report.summary.transitionalJavascriptFiles, 0);
    assert.deepEqual(
      report.findings.map(({ code, file }) => ({ code, file })),
      [
        {
          code: 'unapproved-javascript-source',
          file: 'Webclient.app/src/experience/accessibilityRuntime.test.js',
        },
        {
          code: 'unapproved-javascript-source',
          file: 'Webclient.app/src/platform/http/retryPolicy.test.js',
        },
      ],
    );
  }));

