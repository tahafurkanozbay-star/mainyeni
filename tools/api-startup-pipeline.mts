#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTS = Object.freeze(['Api.User/Program.cs']);
const SHARED = 'Api.Core/Platform/ApiPlatformApplicationExtensions.cs';
const HOST_SEQUENCE = Object.freeze([
  'builder.WebHost.ConfigureKentRehberiTransport',
  'builder.Services.AddKentRehberiApiPlatform',
  'builder.Build',
  'app.UseKentRehberiPlatformBeforeRouting',
  'app.UseRouting',
  'app.UseKentRehberiPlatformAfterRouting',
  'app.UseAuthorization',
  'app.MapKentRehberiHealthChecks',
  'app.MapControllers',
  'app.Run',
]);
const SHARED_SEQUENCE = Object.freeze([
  'app.UseMiddleware<CorrelationIdMiddleware>',
  'app.UseMiddleware<ApiExceptionMiddleware>',
  'app.UseMiddleware<SecurityHeadersMiddleware>',
  'app.UseMiddleware<RequestGovernanceMiddleware>',
  'app.UseMiddleware<RequestGuardMiddleware>',
  'app.UseCors',
  'app.UseMiddleware<RequestMetricsMiddleware>',
  'app.UseRateLimiter',
  'app.UseRequestTimeouts',
]);
const finding = (code, file, detail) => Object.freeze({
  code, severity: 'error', file, package: null, message: detail,
});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Remove comments and quoted literals so audit markers cannot be forged. */
export const stripCSharpTrivia = input => {
  const source = String(input ?? '');
  let result = '', state = 'code', escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; result += '  '; i++; continue; }
      if (ch === '/' && next === '*') { state = 'block'; result += '  '; i++; continue; }
      if (ch === '@' && next === '"') { state = 'verbatim'; result += '  '; i++; continue; }
      if (ch === '"') { state = 'string'; result += ' '; continue; }
      if (ch === '\'') { state = 'char'; result += ' '; continue; }
      result += ch;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; result += '\n'; }
      else result += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { result += '  '; i++; state = 'code'; }
      else result += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'verbatim') {
      if (ch === '"' && next === '"') { result += '  '; i++; }
      else if (ch === '"') { result += ' '; state = 'code'; }
      else result += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (escaped) { escaped = false; result += ' '; continue; }
    if (ch === '\\') { escaped = true; result += ' '; continue; }
    if ((state === 'string' && ch === '"') || (state === 'char' && ch === '\'')) {
      state = 'code'; result += ' '; continue;
    }
    result += ch === '\n' ? '\n' : ' ';
  }
  return result;
};
const calls = (source, methods) => {
  const results = [];
  for (const method of methods) {
    const needle = method.split('.').join('[.]');
    const expression = new RegExp('\\b' + needle + '\\s*\\(' , 'g');
    const positions = [...source.matchAll(expression)].map(match => match.index);
    results.push({ method, positions });
  }
  return results;
};
const validateSequence = (file, source, sequence, findings) => {
  const inventory = calls(source, sequence);
  let last = -1;
  for (const entry of inventory) {
    if (entry.positions.length === 0) {
      findings.push(finding('api-pipeline-step-missing', file, 'Required pipeline step is missing: ' + entry.method));
    } else if (entry.positions.length > 1) {
      findings.push(finding('api-pipeline-step-duplicate', file, 'Pipeline step is declared more than once: ' + entry.method));
    } else if (entry.positions[0] <= last) {
      findings.push(finding('api-pipeline-step-out-of-order', file, 'Pipeline step is out of order: ' + entry.method));
    }
    if (entry.positions.length === 1) last = entry.positions[0];
  }
  return inventory.map(entry => Object.freeze({
    method: entry.method, count: entry.positions.length,
  }));
};

/**
 * Static structural gate complements runtime xUnit tests. It detects startup
 * drift before the application boots, without executing any repository code.
 */
export const evaluateApiStartupPipeline = sources => {
  const findings = [], inventory = [];
  for (const file of [...HOSTS, SHARED]) {
    const raw = sources?.[file];
    if (typeof raw !== 'string') {
      findings.push(finding('api-pipeline-source-missing', file, 'Required API startup source is missing.'));
      continue;
    }
    const source = stripCSharpTrivia(raw);
    const sequence = file === SHARED ? SHARED_SEQUENCE : HOST_SEQUENCE;
    const steps = validateSequence(file, source, sequence, findings);
    if (file !== SHARED) {
      if (!/\boptions\.AddServerHeader\s*=\s*false\s*;/.test(source)) {
        findings.push(finding('api-server-header-enabled', file, 'Kestrel must disable its server header.'));
      }
      if (/\bapp\.UseCors\s*\(/.test(source)) {
        findings.push(finding('api-host-cors-bypass', file, 'Host must use the centrally governed CORS pipeline.'));
      }
      if (file === 'Api.User/Program.cs') {
        const limit = source.indexOf('app.UseMiddleware<GisProxyRequestBodyLimitMiddleware>');
        const routing = source.indexOf('app.UseRouting');
        if (limit < 0 || limit > routing) {
          findings.push(finding('api-gis-body-limit-order', file,
            'GIS proxy body budget must run before routing and controller execution.'));
        }
      }
    }
    inventory.push(Object.freeze({ file, steps: Object.freeze(steps) }));
  }
  findings.sort((a, b) => a.file.localeCompare(b.file, 'en') ||
    a.code.localeCompare(b.code, 'en') || a.message.localeCompare(b.message, 'en'));
  return Object.freeze({
    ok: findings.length === 0,
    summary: Object.freeze({ sources: inventory.length,
      requiredSteps: inventory.reduce((n, item) => n + item.steps.length, 0),
      violations: findings.length }),
    fingerprint: digest(inventory),
    sources: Object.freeze(inventory), findings: Object.freeze(findings),
  });
};
export const runApiStartupPipeline = async root => {
  const sources = {};
  for (const file of [...HOSTS, SHARED]) sources[file] = await readFile(path.join(root, file), 'utf8');
  return evaluateApiStartupPipeline(sources);
};
const escapeMd = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
export const renderApiStartupPipelineMarkdown = report => [
  '# API Startup Pipeline Contract', '',
  '- Gate: **' + (report.ok ? 'PASS' : 'FAIL') + '**',
  '- Fingerprint: ' + report.fingerprint,
  '- Sources: **' + report.summary.sources + '**',
  '- Required steps: **' + report.summary.requiredSteps + '**',
  '- Violations: **' + report.summary.violations + '**', '',
  '| Source | Required steps |', '| --- | ---: |',
  ...report.sources.map(item => '| ' + escapeMd(item.file) + ' | ' + item.steps.length + ' |'),
  '', '## Findings', '', '| Code | File | Detail |', '| --- | --- | --- |',
  ...(report.findings.length ? report.findings.map(item =>
    '| ' + item.code + ' | ' + escapeMd(item.file) + ' | ' + escapeMd(item.message) + ' |') :
    ['| _none_ | | |']), '',
].join('\n');
const main = async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runApiStartupPipeline(root);
  const dir = path.join(root, 'artifacts', 'platform-audit');
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'api-startup-pipeline.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(path.join(dir, 'api-startup-pipeline.md'), renderApiStartupPipelineMarkdown(report)),
  ]);
  console.log(JSON.stringify(report.summary));
  if (!report.ok) process.exitCode = 2;
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
