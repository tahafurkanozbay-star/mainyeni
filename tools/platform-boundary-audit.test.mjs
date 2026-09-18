import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  auditPlatformBoundaries,
  createPlatformBoundaryPolicy,
  formatPlatformBoundaryMarkdown,
} from './platform-boundary-audit.mjs';

const fixture = async (files) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-platform-boundary-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return root;
};

const withFixture = async (files, callback) => {
  const root = await fixture(files);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const codes = (report) => report.findings.map((item) => item.code);

test('policy exposes deterministic default layer order', () => {
  const policy = createPlatformBoundaryPolicy();
  assert.deepEqual(policy.externalDomains, ['core']);
  assert.deepEqual(policy.adapterExternalDomains, ['business', 'store', 'core']);
  assert.equal(policy.tiers.errors, 0);
  assert.equal(policy.tiers.network, 1);
  assert.equal(policy.tiers.http, 2);
  assert.equal(policy.tiers.runtime, 3);
  assert.equal(policy.tiers.bootstrap, 4);
});

test('runtime may depend on http, cache and errors', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': [
      "import { http } from '../http/client';",
      "import { cache } from '../cache/cache';",
      "import { AppError } from '../errors/error';",
      'export { http, cache, AppError };',
    ].join('\n'),
    'Webclient.app/src/platform/http/client.ts': 'export const http = 1;',
    'Webclient.app/src/platform/cache/cache.ts': 'export const cache = 1;',
    'Webclient.app/src/platform/errors/error.ts': 'export class AppError extends Error {}',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
    assert.ok(!codes(report).includes('platform-layer-inversion'));
  });
});

test('http may depend on network and config foundations', async () => {
  await withFixture({
    'Webclient.app/src/platform/http/client.ts': [
      "import { endpoint } from '../network/endpoint';",
      "import { config } from '../config/config';",
      'export { endpoint, config };',
    ].join('\n'),
    'Webclient.app/src/platform/network/endpoint.ts': 'export const endpoint = 1;',
    'Webclient.app/src/platform/config/config.ts': 'export const config = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
  });
});

test('lower-level config cannot import runtime', async () => {
  await withFixture({
    'Webclient.app/src/platform/config/config.ts': "import { runtime } from '../runtime/runtime'; export { runtime };",
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    const item = report.findings.find((finding) => finding.code === 'platform-layer-inversion');
    assert.equal(item?.severity, 'error');
    assert.equal(item?.detail?.sourceArea, 'config');
    assert.equal(item?.detail?.targetArea, 'runtime');
    assert.equal(report.summary.passed, false);
  });
});

test('network cannot import http', async () => {
  await withFixture({
    'Webclient.app/src/platform/network/endpoint.ts': "import { http } from '../http/client'; export { http };",
    'Webclient.app/src/platform/http/client.ts': 'export const http = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.ok(codes(report).includes('platform-layer-inversion'));
  });
});

test('errors cannot import bootstrap composition', async () => {
  await withFixture({
    'Webclient.app/src/platform/errors/error.ts': "import { boot } from '../bootstrap/boot'; export { boot };",
    'Webclient.app/src/platform/bootstrap/boot.ts': 'export const boot = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.ok(codes(report).includes('platform-layer-inversion'));
  });
});

test('bootstrap may depend on runtime and http', async () => {
  await withFixture({
    'Webclient.app/src/platform/bootstrap/boot.ts': [
      "import { runtime } from '../runtime/runtime';",
      "import { http } from '../http/http';",
      'export { runtime, http };',
    ].join('\n'),
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = 1;',
    'Webclient.app/src/platform/http/http.ts': 'export const http = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
  });
});

test('ordinary Platform module cannot import Business', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.ts': "import { business } from '../../Business/business'; export { business };",
    'Webclient.app/src/Business/business.ts': 'export const business = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    const item = report.findings.find((finding) => finding.code === 'platform-external-boundary');
    assert.equal(item?.severity, 'error');
    assert.equal(item?.detail?.importedDomain, 'business');
  });
});

test('ordinary Platform module cannot import Store', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.ts': "import { store } from '../../Store/store'; export { store };",
    'Webclient.app/src/Store/store.ts': 'export const store = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.ok(codes(report).includes('platform-external-boundary'));
  });
});

test('ordinary Platform module may import stable Core foundation', async () => {
  await withFixture({
    'Webclient.app/src/platform/config/config.ts': "import { core } from '../../Core/core'; export { core };",
    'Webclient.app/src/Core/core.ts': 'export const core = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
    assert.ok(codes(report).includes('platform-external-foundation'));
  });
});

test('bootstrapApplication adapter may compose Business and Store', async () => {
  await withFixture({
    'Webclient.app/src/platform/bootstrap/bootstrapApplication.js': [
      "import { business } from '../../Business/business';",
      "import { store } from '../../Store/store';",
      'export { business, store };',
    ].join('\n'),
    'Webclient.app/src/Business/business.ts': 'export const business = 1;',
    'Webclient.app/src/Store/store.ts': 'export const store = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
    assert.equal(
      report.findings.filter((finding) => finding.code === 'platform-composition-adapter').length,
      2,
    );
  });
});

test('composition adapter does not get unlimited domain access', async () => {
  await withFixture({
    'Webclient.app/src/platform/bootstrap/bootstrapApplication.js': "import { component } from '../../Components/a'; export { component };",
    'Webclient.app/src/Components/a.ts': 'export const component = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.ok(codes(report).includes('platform-external-boundary'));
    assert.equal(report.summary.passed, false);
  });
});

test('tests are excluded from production architecture gate', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.test.ts': "import { component } from '../../Components/a'; export { component };",
    'Webclient.app/src/Components/a.ts': 'export const component = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.platformProductionEdges, 0);
    assert.equal(report.summary.passed, true);
  });
});

test('incoming application dependencies are inventory only', async () => {
  await withFixture({
    'Webclient.app/src/Business/business.ts': "import { runtime } from '../platform/runtime/runtime'; export { runtime };",
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.incomingProductionEdges, 1);
    assert.equal(report.incomingEdges[0]?.importerDomain, 'business');
    assert.equal(report.summary.passed, true);
  });
});

test('boundary matrix counts internal responsibility edges', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.ts': [
      "import { a } from '../http/a';",
      "import { b } from '../http/b';",
      'export { a, b };',
    ].join('\n'),
    'Webclient.app/src/platform/http/a.ts': 'export const a = 1;',
    'Webclient.app/src/platform/http/b.ts': 'export const b = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.deepEqual(report.matrix, [
      { boundary: 'runtime -> http', count: 2 },
    ]);
  });
});

test('same responsibility imports are allowed', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': "import { b } from './b'; export { b };",
    'Webclient.app/src/platform/runtime/b.ts': 'export const b = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
    assert.deepEqual(report.matrix, [
      { boundary: 'runtime -> runtime', count: 1 },
    ]);
  });
});

test('unknown Platform subdirectory uses neutral middle tier', async () => {
  await withFixture({
    'Webclient.app/src/platform/custom/a.ts': "import { config } from '../config/config'; export { config };",
    'Webclient.app/src/platform/config/config.ts': 'export const config = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
  });
});

test('custom policy can add a bounded external foundation domain', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.ts': "import { tool } from '../../Toolbox/tool'; export { tool };",
    'Webclient.app/src/Toolbox/tool.ts': 'export const tool = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root, {
      policy: { externalDomains: ['core', 'toolbox'] },
    });
    assert.equal(report.summary.passed, true);
  });
});

test('custom tier policy is honored', async () => {
  await withFixture({
    'Webclient.app/src/platform/config/config.ts': "import { runtime } from '../runtime/runtime'; export { runtime };",
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root, {
      policy: { tiers: { config: 5 } },
    });
    assert.equal(report.summary.passed, true);
  });
});

test('findings are deterministic', async () => {
  await withFixture({
    'Webclient.app/src/platform/config/z.ts': "import { b } from '../../Business/b'; export { b };",
    'Webclient.app/src/platform/config/a.ts': "import { s } from '../../Store/s'; export { s };",
    'Webclient.app/src/Business/b.ts': 'export const b = 1;',
    'Webclient.app/src/Store/s.ts': 'export const s = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    const files = report.findings
      .filter((finding) => finding.code === 'platform-external-boundary')
      .map((finding) => finding.file);
    assert.deepEqual(files, [
      'Webclient.app/src/platform/config/a.ts',
      'Webclient.app/src/platform/config/z.ts',
    ]);
  });
});

test('markdown exposes gate, order, matrix and incoming dependencies', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': "import { b } from '../http/b'; export { b };",
    'Webclient.app/src/platform/http/b.ts': 'export const b = 1;',
  }, async (root) => {
    const report = await auditPlatformBoundaries(root);
    const markdown = formatPlatformBoundaryMarkdown(report);
    assert.match(markdown, /Platform Boundary Audit/);
    assert.match(markdown, /Gate: \*\*PASS\*\*/);
    assert.match(markdown, /errors\/config/);
    assert.match(markdown, /Platform dependency matrix/);
    assert.match(markdown, /Incoming application dependencies/);
    assert.match(markdown, /runtime -> http/);
  });
});

test('empty source tree produces passing report', async () => {
  await withFixture({}, async (root) => {
    const report = await auditPlatformBoundaries(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.platformProductionEdges, 0);
    assert.deepEqual(report.matrix, []);
    assert.deepEqual(report.findings, []);
  });
});
