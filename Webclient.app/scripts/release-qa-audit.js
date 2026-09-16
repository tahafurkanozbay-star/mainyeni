#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'src');
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.json', '.css', '.html', '.md']);
const SEVERITY_WEIGHT = { critical: 100, high: 40, medium: 10, low: 2, info: 0 };

const rules = [
  { id: 'secret-client-key', severity: 'critical', scope: 'source', pattern: /REACT_APP_(?:CLIENT_KEY|API_KEY|SECRET|TOKEN)|client[_-]?secret/i, message: 'Client bundle must not contain privileged keys or secrets.' },
  { id: 'unsafe-eval', severity: 'critical', scope: 'source', pattern: /\beval\s*\(|new\s+Function\s*\(/, message: 'Dynamic code execution is forbidden in the browser runtime.' },
  { id: 'unsafe-html', severity: 'high', scope: 'source', pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML\s*\(/, message: 'Unsafe HTML sinks require explicit sanitization review.' },
  { id: 'insecure-protocol', severity: 'high', scope: 'source', pattern: /http:\/\//i, message: 'Plain HTTP endpoint or asset detected.' },
  { id: 'wms-wfs', severity: 'high', scope: 'source', pattern: /\b(?:WMS|WFS)\b|service=WMS|service=WFS/i, message: 'WMS/WFS integration is outside the verified GIS protocol.' },
  { id: 'remote-font', severity: 'medium', scope: 'source', pattern: /fonts\.(?:googleapis|gstatic)\.com|@import\s+url\s*\(\s*['"]?https?:/i, message: 'Remote font/style dependency increases privacy, availability and performance risk.' },
  { id: 'window-open', severity: 'medium', scope: 'source', pattern: /window\.open\s*\(/, message: 'External navigation must enforce safe URL policy and noopener/noreferrer.' },
  { id: 'global-graphics-clear', severity: 'medium', scope: 'source', pattern: /RemoveAllGraphics\s*\(|graphics\.removeAll\s*\(/, message: 'Global graphic cleanup can violate cross-tool ownership.' },
  { id: 'console-error', severity: 'low', scope: 'source', pattern: /console\.(?:error|warn)\s*\(/, message: 'Console output should be intentional and bounded in production.' },
  { id: 'todo-fixme', severity: 'info', scope: 'source', pattern: /\b(?:TODO|FIXME|HACK)\b/, message: 'Tracked implementation debt marker.' },
];

function normalizePath(file) {
  return file.split(path.sep).join('/');
}

function walk(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(full);
  }
  return output;
}

function readText(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_TEXT_BYTES) return null;
  return fs.readFileSync(file, 'utf8');
}

function lineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function scanFile(file, text) {
  const findings = [];
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const matcher = new RegExp(rule.pattern.source, flags);
    let match;
    while ((match = matcher.exec(text))) {
      const start = Math.max(0, match.index - 70);
      const end = Math.min(text.length, match.index + match[0].length + 90);
      findings.push({
        id: rule.id,
        severity: rule.severity,
        file: normalizePath(path.relative(ROOT, file)),
        line: lineNumber(text, match.index),
        message: rule.message,
        evidence: text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 240),
      });
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }
  return findings;
}

function inspectPackage() {
  const packageFile = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const findings = [];
  const requiredScripts = ['build', 'test'];
  for (const script of requiredScripts) {
    if (!pkg.scripts || !pkg.scripts[script]) findings.push({ id: `missing-script-${script}`, severity: 'high', file: 'package.json', line: 1, message: `Required ${script} script is missing.`, evidence: '' });
  }
  const debt = [
    ['react-scripts', /^4\./, 'high', 'CRA 4 is a legacy build baseline and should remain under controlled migration.'],
    ['axios', /^(?:\^|~)?0\./, 'high', 'Axios 0.x is legacy dependency debt; runtime usage should be eliminated before package removal.'],
    ['react', /^(?:\^|~)?17\./, 'medium', 'React 17 is a legacy UI baseline; major migration requires dedicated compatibility work.'],
    ['jspdf', /^(?:\^|~)?2\.4\./, 'medium', 'jsPDF 2.4 baseline should be reviewed against current security advisories.'],
  ];
  for (const [name, versionPattern, severity, message] of debt) {
    if (deps[name] && versionPattern.test(deps[name])) findings.push({ id: `dependency-debt-${name}`, severity, file: 'package.json', line: 1, message, evidence: `${name}@${deps[name]}` });
  }
  return { package: pkg, findings };
}

function inspectIconRegistry() {
  const registryFile = path.join(SOURCE_ROOT, 'gis-engine', 'iconRegistry.json');
  if (!fs.existsSync(registryFile)) return [{ id: 'icon-registry-missing', severity: 'critical', file: 'src/gis-engine/iconRegistry.json', line: 1, message: 'Shared GIS icon registry is missing.', evidence: '' }];
  try {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const serialized = JSON.stringify(registry);
    if (serialized.length < 20) return [{ id: 'icon-registry-empty', severity: 'high', file: 'src/gis-engine/iconRegistry.json', line: 1, message: 'Shared GIS icon registry appears empty.', evidence: '' }];
    return [];
  } catch (error) {
    return [{ id: 'icon-registry-invalid-json', severity: 'critical', file: 'src/gis-engine/iconRegistry.json', line: 1, message: 'Shared GIS icon registry is invalid JSON.', evidence: error.message }];
  }
}

function inspectArchitecture(files) {
  const findings = [];
  const sourceNames = files.map(file => normalizePath(path.relative(SOURCE_ROOT, file)));
  const required = ['gis-engine/iconResolver.js', 'gis-engine/serviceRegistry.js', 'gis-engine/layerRuntime.js', 'gis-engine/spatialEngine.js'];
  for (const expected of required) {
    if (!sourceNames.includes(expected)) findings.push({ id: `missing-${expected.replace(/[^a-z0-9]+/gi, '-')}`, severity: 'critical', file: expected, line: 1, message: `Required shared GIS runtime ${expected} is missing.`, evidence: '' });
  }
  const duplicateRegistry = sourceNames.filter(name => /icon.*registry.*\.json$/i.test(name));
  if (duplicateRegistry.length > 1) findings.push({ id: 'duplicate-icon-authority', severity: 'high', file: duplicateRegistry.join(', '), line: 1, message: 'Multiple icon registry JSON files can create 2D/3D/list presentation drift.', evidence: duplicateRegistry.join(', ') });
  return findings;
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter(item => {
    const key = `${item.id}|${item.file}|${item.line}|${item.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(findings, files) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let score = 0;
  for (const finding of findings) {
    counts[finding.severity] += 1;
    score += SEVERITY_WEIGHT[finding.severity];
  }
  return {
    generatedAt: new Date().toISOString(),
    filesScanned: files.length,
    findings: findings.length,
    counts,
    riskScore: score,
    releaseGate: counts.critical === 0 ? (counts.high === 0 ? 'pass' : 'review') : 'block',
  };
}

function markdown(report) {
  const lines = [
    '# Kent Rehberi Release QA Audit', '',
    `- Files scanned: ${report.summary.filesScanned}`,
    `- Findings: ${report.summary.findings}`,
    `- Critical: ${report.summary.counts.critical}`,
    `- High: ${report.summary.counts.high}`,
    `- Medium: ${report.summary.counts.medium}`,
    `- Low: ${report.summary.counts.low}`,
    `- Informational: ${report.summary.counts.info}`,
    `- Risk score: ${report.summary.riskScore}`,
    `- Release gate: **${report.summary.releaseGate.toUpperCase()}**`, '',
    '## Findings', '',
  ];
  if (!report.findings.length) lines.push('No static release findings.');
  for (const finding of report.findings) {
    lines.push(`### ${finding.severity.toUpperCase()} — ${finding.id}`, '', `- Location: \`${finding.file}:${finding.line}\``, `- ${finding.message}`, finding.evidence ? `- Evidence: \`${finding.evidence.replace(/`/g, "'")}\`` : '', '');
  }
  return lines.filter(line => line !== '').join('\n') + '\n';
}

function run(options = {}) {
  const files = walk(options.sourceRoot || SOURCE_ROOT);
  let findings = [];
  for (const file of files) {
    const text = readText(file);
    if (text !== null) findings.push(...scanFile(file, text));
  }
  findings.push(...inspectPackage().findings, ...inspectIconRegistry(), ...inspectArchitecture(files));
  findings = dedupe(findings).sort((a, b) => (SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) || a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  const report = { summary: summarize(findings, files), findings };
  return report;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const report = run();
  const outputDir = path.join(ROOT, 'qa-artifacts');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'release-qa-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'release-qa-report.md'), markdown(report));
  process.stdout.write(`${markdown(report)}\n`);
  if (args.has('--strict') && report.summary.counts.critical > 0) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { rules, walk, scanFile, inspectPackage, inspectIconRegistry, inspectArchitecture, dedupe, summarize, markdown, run };
