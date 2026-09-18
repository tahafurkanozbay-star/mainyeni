#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildPlatformModuleGraph,
} from './platform-module-graph.mjs';

const DEFAULT_ROOT = path.resolve(process.cwd());
const PLATFORM_PREFIX = 'Webclient.app/src/platform/';
const ADAPTER_PATH = 'Webclient.app/src/platform/bootstrap/bootstrapApplication.js';

const TIER = Object.freeze({
  errors: 0,
  config: 0,
  network: 0,
  cache: 1,
  http: 2,
  performance: 3,
  runtime: 3,
  bootstrap: 4,
});

const DEFAULT_EXTERNAL_DOMAINS = Object.freeze(['core']);
const ADAPTER_EXTERNAL_DOMAINS = Object.freeze(['business', 'store', 'core']);

const platformArea = (file) => {
  if (!file.startsWith(PLATFORM_PREFIX)) return null;
  const remainder = file.slice(PLATFORM_PREFIX.length);
  return remainder.split('/')[0] || 'root';
};

const finding = (severity, code, message, edge = null, detail = null) =>
  Object.freeze({
    severity,
    code,
    message,
    file: edge?.importer ?? null,
    line: edge?.line ?? null,
    detail,
  });

const sortedFindings = (findings) => [...findings].sort((left, right) =>
  left.severity.localeCompare(right.severity)
  || String(left.file || '').localeCompare(String(right.file || ''))
  || Number(left.line || 0) - Number(right.line || 0)
  || left.code.localeCompare(right.code));

export const createPlatformBoundaryPolicy = (overrides = {}) => Object.freeze({
  externalDomains: Object.freeze([
    ...(overrides.externalDomains ?? DEFAULT_EXTERNAL_DOMAINS),
  ]),
  adapterPath: String(overrides.adapterPath ?? ADAPTER_PATH),
  adapterExternalDomains: Object.freeze([
    ...(overrides.adapterExternalDomains ?? ADAPTER_EXTERNAL_DOMAINS),
  ]),
  tiers: Object.freeze({
    ...TIER,
    ...(overrides.tiers ?? {}),
  }),
});

const edgeKey = (edge) => edge.importer + ' -> ' + edge.imported;

const boundaryMatrix = (edges) => {
  const counts = new Map();
  for (const edge of edges) {
    const from = platformArea(edge.importer) ?? edge.importerDomain;
    const to = platformArea(edge.imported) ?? edge.importedDomain;
    const key = from + ' -> ' + to;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.freeze([...counts.entries()]
    .map(([boundary, count]) => Object.freeze({ boundary, count }))
    .sort((left, right) => left.boundary.localeCompare(right.boundary)));
};

export const auditPlatformBoundaries = async (
  root = DEFAULT_ROOT,
  options = {},
) => {
  const policy = createPlatformBoundaryPolicy(options.policy ?? {});
  const graph = options.graph ?? await buildPlatformModuleGraph(root);
  const findings = [];
  const platformEdges = graph.edges
    .filter((edge) => !edge.test && edge.importer.startsWith(PLATFORM_PREFIX))
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)) || left.line - right.line);

  for (const edge of platformEdges) {
    if (edge.imported.startsWith(PLATFORM_PREFIX)) {
      const sourceArea = platformArea(edge.importer);
      const targetArea = platformArea(edge.imported);
      const sourceTier = policy.tiers[sourceArea] ?? 2;
      const targetTier = policy.tiers[targetArea] ?? 2;
      if (sourceTier < targetTier) {
        findings.push(finding(
          'error',
          'platform-layer-inversion',
          'Lower-level Platform module imports a higher-level Platform responsibility.',
          edge,
          {
            sourceArea,
            targetArea,
            sourceTier,
            targetTier,
            imported: edge.imported,
          },
        ));
      }
      continue;
    }

    const allowedDomains = edge.importer === policy.adapterPath
      ? policy.adapterExternalDomains
      : policy.externalDomains;
    if (!allowedDomains.includes(edge.importedDomain)) {
      findings.push(finding(
        'error',
        'platform-external-boundary',
        'Platform production code imports an application domain outside its bounded architecture contract.',
        edge,
        {
          imported: edge.imported,
          importedDomain: edge.importedDomain,
          allowedDomains,
        },
      ));
    } else {
      findings.push(finding(
        'info',
        edge.importer === policy.adapterPath
          ? 'platform-composition-adapter'
          : 'platform-external-foundation',
        'Platform external dependency is explicitly allowed by the architecture policy.',
        edge,
        {
          imported: edge.imported,
          importedDomain: edge.importedDomain,
        },
      ));
    }
  }

  const incoming = graph.edges
    .filter((edge) =>
      !edge.test
      && !edge.importer.startsWith(PLATFORM_PREFIX)
      && edge.imported.startsWith(PLATFORM_PREFIX))
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)) || left.line - right.line);

  const ordered = Object.freeze(sortedFindings(findings));
  const errors = ordered.filter((item) => item.severity === 'error').length;
  const warnings = ordered.filter((item) => item.severity === 'warning').length;
  const infos = ordered.filter((item) => item.severity === 'info').length;

  return Object.freeze({
    policy,
    summary: Object.freeze({
      generatedAt: new Date().toISOString(),
      passed: errors === 0,
      errors,
      warnings,
      infos,
      platformProductionEdges: platformEdges.length,
      incomingProductionEdges: incoming.length,
    }),
    platformEdges: Object.freeze(platformEdges),
    incomingEdges: Object.freeze(incoming),
    matrix: boundaryMatrix(platformEdges),
    findings: ordered,
  });
};

const table = (headers, rows) => [
  '| ' + headers.join(' | ') + ' |',
  '| ' + headers.map(() => '---').join(' | ') + ' |',
  ...(rows.length > 0 ? rows.map((row) => '| ' + row.join(' | ') + ' |') : ['| _none_ |']),
].join('\n');

export const formatPlatformBoundaryMarkdown = (report) => {
  const findings = report.findings.map((item) => [
    item.severity,
    item.code,
    item.file || '',
    item.line == null ? '' : String(item.line),
    item.message.replaceAll('|', '\\|'),
  ]);
  const matrix = report.matrix.map((item) => [item.boundary, String(item.count)]);
  const incoming = report.incomingEdges.map((edge) => [
    edge.importerDomain,
    edge.importer,
    edge.imported,
    String(edge.line),
  ]);

  return [
    '# Platform Boundary Audit',
    '',
    'Generated: ' + report.summary.generatedAt,
    '',
    'Gate: **' + (report.summary.passed ? 'PASS' : 'FAIL') + '**',
    '',
    '- Platform production edges: **' + report.summary.platformProductionEdges + '**',
    '- Incoming production edges: **' + report.summary.incomingProductionEdges + '**',
    '- Errors / warnings / info: **' + report.summary.errors + ' / ' + report.summary.warnings + ' / ' + report.summary.infos + '**',
    '',
    '## Responsibility order',
    '',
    'errors/config/network -> cache -> http -> runtime/performance -> bootstrap',
    '',
    'Endpoint/network policy is a pure foundation beside errors/config; transport remains in http. Lower-level modules may not import higher-level responsibilities. External application-domain imports are forbidden except the bounded bootstrap composition adapter and stable Core foundation types.',
    '',
    '## Findings',
    '',
    table(['Severity', 'Code', 'File', 'Line', 'Message'], findings),
    '',
    '## Platform dependency matrix',
    '',
    table(['Boundary', 'Edges'], matrix),
    '',
    '## Incoming application dependencies',
    '',
    table(['Domain', 'Importer', 'Platform target', 'Line'], incoming),
    '',
  ].join('\n');
};

const main = async () => {
  const strict = process.argv.includes('--strict');
  const report = await auditPlatformBoundaries(DEFAULT_ROOT);
  const outDir = path.join(DEFAULT_ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'platform-boundaries.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'platform-boundaries.md'), formatPlatformBoundaryMarkdown(report));
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
  if (strict && !report.summary.passed) process.exitCode = 2;
};

if (import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
