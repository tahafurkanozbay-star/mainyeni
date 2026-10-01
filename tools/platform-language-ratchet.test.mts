import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  auditLanguageModernization,
  formatLanguageModernizationMarkdown,
} from './platform-language-ratchet.mjs';

const fixture = async (files, baseline) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-language-ratchet-'));
  const merged = {
    'tools/platform-language-baseline.json': JSON.stringify({
      schemaVersion: 1,
      description: 'fixture',
      domains: baseline,
      platformLegacyAllowlist: [
        'Webclient.app/src/platform/bootstrap/bootstrapApplication.js',
      ],
    }),
    ...files,
  };
  for (const [name, content] of Object.entries(merged)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return root;
};

const withFixture = async (files, baseline, callback) => {
  const root = await fixture(files, baseline);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('passes when JavaScript counts remain at or below domain budgets', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.js': 'export const a = 1;',
    'Webclient.app/src/Business/b.ts': 'export const b = 1;',
    'Webclient.app/src/platform/bootstrap/bootstrapApplication.js': 'export const boot = 1;',
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = 1;',
  }, { business: 2, platform: 1 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.productionJavascriptFiles, 2);
    assert.equal(report.summary.productionTypescriptFiles, 2);
    assert.equal(report.domains.find((item) => item.domain === 'business')?.productionJavascriptFiles, 1);
  });
});

test('fails when a domain adds JavaScript above its ratcheted ceiling', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.js': 'export const a = 1;',
    'Webclient.app/src/Business/b.js': 'export const b = 1;',
  }, { business: 1, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    const item = report.findings.find((finding) => finding.code === 'javascript-budget-regression');
    assert.equal(item?.severity, 'error');
    assert.deepEqual(item?.detail, { domain: 'business', current: 2, budget: 1 });
    assert.equal(report.summary.passed, false);
  });
});

test('zero-JavaScript domains are permanently protected', async () => {
  await withFixture({
    'Webclient.app/src/gis-engine/newLegacy.js': 'export const legacy = true;',
  }, { gis: 0, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.ok(report.findings.some((finding) =>
      finding.code === 'javascript-budget-regression'
      && finding.detail?.domain === 'gis'
      && finding.detail?.budget === 0));
  });
});

test('unbudgeted domain with production JavaScript fails closed', async () => {
  await withFixture({
    'Webclient.app/src/NewDomain/legacy.js': 'export const legacy = true;',
  }, { platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.ok(report.findings.some((finding) =>
      finding.code === 'unbudgeted-javascript-domain'
      && finding.detail?.domain === 'web-root'));
    assert.equal(report.summary.passed, false);
  });
});

test('unbudgeted domain with TypeScript only is allowed', async () => {
  await withFixture({
    'Webclient.app/src/NewDomain/modern.ts': 'export const modern = true;',
  }, { platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.equal(report.summary.passed, true);
  });
});

test('Platform JavaScript must be explicitly allowlisted', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/legacy.js': 'export const legacy = true;',
  }, { platform: 1 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.ok(report.findings.some((finding) =>
      finding.code === 'platform-javascript-not-allowlisted'
      && finding.file === 'Webclient.app/src/platform/runtime/legacy.js'));
    assert.equal(report.summary.passed, false);
  });
});

test('allowlisted bootstrap adapter is accepted within Platform budget', async () => {
  await withFixture({
    'Webclient.app/src/platform/bootstrap/bootstrapApplication.js': 'export const boot = true;',
  }, { platform: 1 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.equal(report.summary.passed, true);
    assert.ok(!report.findings.some((finding) =>
      finding.code === 'platform-javascript-not-allowlisted'));
  });
});

test('stale Platform allowlist becomes informational cleanup work', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = true;',
  }, { platform: 1 }, async (root) => {
    const report = await auditLanguageModernization(root);
    const item = report.findings.find((finding) =>
      finding.code === 'stale-platform-javascript-allowlist');
    assert.equal(item?.severity, 'info');
    assert.equal(report.summary.passed, true);
  });
});

test('test files are measured separately and do not consume production JS ceiling', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.test.js': 'export const testA = 1;',
    'Webclient.app/src/Business/b.spec.ts': 'export const testB = 1;',
  }, { business: 0, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    const business = report.domains.find((item) => item.domain === 'business');
    assert.equal(business?.productionJavascriptFiles, 0);
    assert.equal(business?.testJavascriptFiles, 1);
    assert.equal(business?.testTypescriptFiles, 1);
    assert.equal(report.summary.passed, true);
  });
});

test('test JavaScript ceiling fails closed when a domain regresses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-language-test-ratchet-'));
  try {
    const baselinePath = path.join(root, 'tools/platform-language-baseline.json');
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, JSON.stringify({
      schemaVersion: 1,
      domains: { platform: 0 },
      testDomains: { platform: 0 },
      platformLegacyAllowlist: [],
    }));
    const testPath = path.join(root, 'Webclient.app/src/platform/runtime/regression.test.js');
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, 'export const regression = true;');
    const report = await auditLanguageModernization(root);
    const finding = report.findings.find((item) => item.code === 'test-javascript-budget-regression');
    assert.equal(finding?.severity, 'error');
    assert.deepEqual(finding?.detail, { domain: 'platform', current: 1, budget: 0 });
    assert.equal(report.summary.passed, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('domain mapping covers core repository architecture buckets', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.ts': 'export {};',
    'Webclient.app/src/Components/a.tsx': 'export {};',
    'Webclient.app/src/Core/a.ts': 'export {};',
    'Webclient.app/src/Store/a.ts': 'export {};',
    'Webclient.app/src/Toolbox/a.ts': 'export {};',
    'Webclient.app/src/data-search/a.ts': 'export {};',
    'Webclient.app/src/experience/a.ts': 'export {};',
    'Webclient.app/src/gis-engine/a.ts': 'export {};',
    'Webclient.app/src/platform/a.ts': 'export {};',
    'Webclient.app/src/App.tsx': 'export {};',
  }, {
    business: 0,
    components: 0,
    core: 0,
    store: 0,
    toolbox: 0,
    'data-search': 0,
    experience: 0,
    gis: 0,
    platform: 0,
    'web-root': 0,
  }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.deepEqual(report.domains.map((item) => item.domain), [
      'business',
      'components',
      'core',
      'data-search',
      'experience',
      'gis',
      'platform',
      'store',
      'toolbox',
      'web-root',
    ]);
    assert.ok(report.domains.every((item) => item.productionTypescriptFiles === 1));
  });
});

test('typed production ratio uses files rather than tests', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.ts': 'export {};',
    'Webclient.app/src/Business/b.js': 'export {};',
    'Webclient.app/src/Business/a.test.ts': 'export {};',
    'Webclient.app/src/Business/b.test.js': 'export {};',
  }, { business: 1, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.equal(report.summary.productionFiles, 2);
    assert.equal(report.summary.typedProductionRatio, 0.5);
  });
});

test('line metrics are split by production language', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.ts': 'export const a = 1;\nexport const b = 2;\n',
    'Webclient.app/src/Business/b.js': 'export const c = 3;\n',
  }, { business: 1, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    const business = report.domains.find((item) => item.domain === 'business');
    assert.equal(business?.productionTypescriptLines, 3);
    assert.equal(business?.productionJavascriptLines, 2);
  });
});

test('migration queue contains production JavaScript only', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.js': 'export const a = 1;',
    'Webclient.app/src/Business/a.test.js': 'export const testA = 1;',
    'Webclient.app/src/Business/b.ts': 'export const b = 1;',
  }, { business: 1, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.deepEqual(report.migrationQueue.map((item) => item.path), [
      'Webclient.app/src/Business/a.js',
    ]);
  });
});

test('migration priority favors Platform then Business for similar files', async () => {
  await withFixture({
    'Webclient.app/src/platform/bootstrap/bootstrapApplication.js': 'export const a = 1;',
    'Webclient.app/src/Business/a.js': 'export const b = 1;',
    'Webclient.app/src/Components/a.js': 'export const c = 1;',
  }, { platform: 1, business: 1, components: 1 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.deepEqual(report.migrationQueue.map((item) => item.domain), [
      'platform',
      'business',
      'components',
    ]);
  });
});

test('large legacy files rank ahead within one domain', async () => {
  await withFixture({
    'Webclient.app/src/Business/small.js': 'export const a = 1;',
    'Webclient.app/src/Business/large.js': 'export const a = 1;\n'.repeat(300),
  }, { business: 2, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.equal(report.migrationQueue[0]?.path, 'Webclient.app/src/Business/large.js');
    assert.ok(report.migrationQueue[0].priority > report.migrationQueue[1].priority);
  });
});

test('markdown exposes ratchet, typed ratio, queue and findings', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.js': 'export const a = 1;',
    'Webclient.app/src/Business/b.ts': 'export const b = 1;',
  }, { business: 1, platform: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    const markdown = formatLanguageModernizationMarkdown(report);
    assert.match(markdown, /Language Modernization Ratchet/);
    assert.match(markdown, /Gate: \*\*PASS\*\*/);
    assert.match(markdown, /Domain ratchet/);
    assert.match(markdown, /Migration queue/);
    assert.match(markdown, /business/);
    assert.match(markdown, /50\.0%/);
  });
});

test('invalid negative baseline is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-language-ratchet-invalid-'));
  try {
    const baselinePath = path.join(root, 'tools/platform-language-baseline.json');
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, JSON.stringify({
      schemaVersion: 1,
      domains: { platform: -1 },
    }));
    await assert.rejects(auditLanguageModernization(root), /Invalid JavaScript budget/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('invalid baseline schema is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-language-ratchet-schema-'));
  try {
    const baselinePath = path.join(root, 'tools/platform-language-baseline.json');
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, JSON.stringify({ schemaVersion: 2, domains: {} }));
    await assert.rejects(auditLanguageModernization(root), /schemaVersion=1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('findings remain deterministic by severity, file and code', async () => {
  await withFixture({
    'Webclient.app/src/platform/z.js': 'export const z = 1;',
    'Webclient.app/src/platform/a.js': 'export const a = 1;',
  }, { platform: 2 }, async (root) => {
    const report = await auditLanguageModernization(root);
    const files = report.findings
      .filter((item) => item.code === 'platform-javascript-not-allowlisted')
      .map((item) => item.file);
    assert.deepEqual(files, [
      'Webclient.app/src/platform/a.js',
      'Webclient.app/src/platform/z.js',
    ]);
  });
});

test('empty source tree is valid when budgets are zero', async () => {
  await withFixture({}, { platform: 0, gis: 0 }, async (root) => {
    const report = await auditLanguageModernization(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.productionFiles, 0);
    assert.equal(report.summary.productionJavascriptFiles, 0);
    assert.equal(report.summary.productionTypescriptFiles, 0);
    assert.deepEqual(report.migrationQueue, []);
  });
});
