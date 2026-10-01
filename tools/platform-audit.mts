#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());
const SKIP_DIRS = new Set(['.git','node_modules','bin','obj','build','dist','coverage','.next','.cache']);
const TEXT_EXT = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.cs','.csproj','.props','.targets','.json','.yml','.yaml','.css','.scss','.html','.md','.env','.config']);
const CODE_EXT = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.cs']);
const NETWORK_PATTERNS = [
  ['absolute-http', /https?:\/\/[^\s'"`)]+/g],
  ['fetch', /\bfetch\s*\(/g],
  ['axios', /\baxios(?:\.|\s*\()/g],
  ['xhr', /\bXMLHttpRequest\b/g],
  ['websocket', /\bWebSocket\s*\(/g],
  ['eventsource', /\bEventSource\s*\(/g],
];
const SECURITY_PATTERNS = [
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/g, 'high'],
  ['innerHTML', /\.innerHTML\s*=/g, 'high'],
  ['eval', /\beval\s*\(/g, 'critical'],
  ['new-function', /\bnew\s+Function\s*\(/g, 'critical'],
  ['document-write', /document\.write\s*\(/g, 'high'],
  ['local-storage-token', /localStorage\.(?:setItem|getItem)\s*\(\s*['"`](?:token|accessToken|jwt)/gi, 'high'],
  ['client-secret-name', /(?:client[_-]?secret|api[_-]?key|private[_-]?key)\s*[:=]/gi, 'medium'],
];
const LEGACY_PATTERNS = [
  ['reactdom-render', /ReactDOM\.render\s*\(/g],
  ['component-will-mount', /componentWillMount\s*\(/g],
  ['component-will-receive-props', /componentWillReceiveProps\s*\(/g],
  ['component-will-update', /componentWillUpdate\s*\(/g],
  ['jquery', /\b(?:jQuery|\$)\s*\(/g],
  ['var-declaration', /(^|[;{}]\s*)var\s+/gm],
  ['promise-polyfill', /promise-polyfill/g],
  ['abortcontroller-polyfill', /abortcontroller-polyfill/g],
];

function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function countLines(text) { return text === '' ? 0 : text.split(/\r?\n/).length; }
function matchCount(text, regex) { const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`; return [...text.matchAll(new RegExp(regex.source, flags))].length; }
function pushFinding(bucket, item) { bucket.push(item); }

async function walk(dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else files.push(full);
  }
  return files;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return null; }
}

function parseTargetFramework(text) {
  return [...text.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)].flatMap(m => m[1].split(';').map(x => x.trim()));
}

function packageRisk(name, version) {
  const v = String(version || '').replace(/^[~^<>= ]+/, '');
  const major = Number.parseInt(v.split('.')[0], 10);
  if (name === 'react-scripts' && major < 5) return 'high';
  if (name === 'react' && major < 18) return 'medium';
  if (name === 'react-dom' && major < 18) return 'medium';
  if (name === 'axios' && major === 0) return 'high';
  if (name === 'jspdf' && major < 3) return 'medium';
  if (name === 'crypto-js' && major < 4) return 'medium';
  return null;
}

async function inspectPackages(root, files, report) {
  for (const file of files.filter(f => path.basename(f) === 'package.json')) {
    const json = await readJson(file);
    if (!json) continue;
    const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
    const risks = Object.entries(deps).map(([name, version]) => ({ name, version, severity: packageRisk(name, version) })).filter(x => x.severity);
    report.packages.push({ file: rel(root, file), name: json.name || null, scripts: Object.keys(json.scripts || {}).sort(), dependencyCount: Object.keys(deps).length, risks });
  }
}

async function inspectDotnet(root, files, report) {
  for (const file of files.filter(f => f.endsWith('.csproj') || f.endsWith('.props'))) {
    const text = await fs.readFile(file, 'utf8');
    const frameworks = parseTargetFramework(text);
    const packages = [...text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)].map(m => ({ name: m[1], version: m[2] || null }));
    if (frameworks.length || packages.length) report.dotnet.push({ file: rel(root, file), frameworks, packages });
  }
}

function inspectText(root, file, text, report) {
  const relative = rel(root, file);
  const ext = path.extname(file).toLowerCase();
  const lines = countLines(text);
  report.metrics.textFiles += 1;
  report.metrics.textLines += lines;
  if (CODE_EXT.has(ext)) { report.metrics.codeFiles += 1; report.metrics.codeLines += lines; }

  for (const [kind, regex] of NETWORK_PATTERNS) {
    const count = matchCount(text, regex);
    if (count) pushFinding(report.network, { file: relative, kind, count });
  }
  for (const [kind, regex, severity] of SECURITY_PATTERNS) {
    const count = matchCount(text, regex);
    if (count) pushFinding(report.security, { file: relative, kind, severity, count });
  }
  for (const [kind, regex] of LEGACY_PATTERNS) {
    const count = matchCount(text, regex);
    if (count) pushFinding(report.legacy, { file: relative, kind, count });
  }
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(text)) pushFinding(report.externalAssets, { file: relative, kind: 'remote-google-font' });
  if (/cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net/.test(text)) pushFinding(report.externalAssets, { file: relative, kind: 'runtime-cdn' });
  if (/Access-Control-Allow-Origin[^\n]*\*/i.test(text)) pushFinding(report.security, { file: relative, kind: 'wildcard-cors', severity: 'high', count: 1 });
}

function summarize(report) {
  const severityScore = { critical: 4, high: 3, medium: 2, low: 1 };
  const securityScore = report.security.reduce((n, f) => n + (severityScore[f.severity] || 1) * f.count, 0);
  const packageRiskCount = report.packages.reduce((n, p) => n + p.risks.length, 0);
  const externalHosts = new Set();
  for (const f of report.network.filter(x => x.kind === 'absolute-http')) externalHosts.add(f.file);
  return {
    generatedAt: new Date().toISOString(),
    codeFiles: report.metrics.codeFiles,
    codeLines: report.metrics.codeLines,
    packageManifests: report.packages.length,
    dotnetManifests: report.dotnet.length,
    securityFindingCount: report.security.reduce((n, f) => n + f.count, 0),
    securityWeightedScore: securityScore,
    legacyFindingCount: report.legacy.reduce((n, f) => n + f.count, 0),
    packageRiskCount,
    networkFindingCount: report.network.reduce((n, f) => n + f.count, 0),
    externalAssetFindingCount: report.externalAssets.length,
    filesWithAbsoluteHttp: externalHosts.size,
  };
}

function markdown(report) {
  const s = report.summary;
  const rows = (items, columns) => items.length ? items.map(item => `| ${columns.map(c => String(item[c] ?? '')).join(' | ')} |`).join('\n') : '| _none_ | | | |';
  return `# Platform Architecture Audit\n\nGenerated: ${s.generatedAt}\n\n## Repository metrics\n\n| Metric | Value |\n| --- | ---: |\n| Code files | ${s.codeFiles} |\n| Code lines | ${s.codeLines} |\n| package.json manifests | ${s.packageManifests} |\n| .NET manifests | ${s.dotnetManifests} |\n| Security findings | ${s.securityFindingCount} |\n| Weighted security score | ${s.securityWeightedScore} |\n| Legacy findings | ${s.legacyFindingCount} |\n| Package baseline risks | ${s.packageRiskCount} |\n| Network findings | ${s.networkFindingCount} |\n| External asset findings | ${s.externalAssetFindingCount} |\n\n## Package baseline risks\n\n${report.packages.flatMap(p => p.risks.map(r => `- **${r.severity}** ${p.file}: ${r.name}@${r.version}`)).join('\n') || '- none'}\n\n## Security review queue\n\n| File | Kind | Severity | Count |\n| --- | --- | --- | ---: |\n${rows(report.security, ['file','kind','severity','count'])}\n\n## Network review queue\n\n| File | Kind | Count |\n| --- | --- | ---: |\n${report.network.length ? report.network.map(x => `| ${x.file} | ${x.kind} | ${x.count} |`).join('\n') : '| _none_ | | |'}\n\n## Legacy review queue\n\n| File | Kind | Count |\n| --- | --- | ---: |\n${report.legacy.length ? report.legacy.map(x => `| ${x.file} | ${x.kind} | ${x.count} |`).join('\n') : '| _none_ | | |'}\n\n## External assets\n\n${report.externalAssets.map(x => `- ${x.file}: ${x.kind}`).join('\n') || '- none'}\n\n## Interpretation\n\nThis report is an inventory, not an automatic vulnerability verdict. Every item must be reviewed in context. Browser-visible data is treated as observable; authorization and data minimization belong on the server/BFF boundary. WMS/WFS are intentionally not introduced by this audit.\n`;
}

export async function runAudit(root = ROOT) {
  const auditRoot = path.resolve(root);
  const files = await walk(auditRoot);
  const report = { metrics: { textFiles: 0, textLines: 0, codeFiles: 0, codeLines: 0 }, packages: [], dotnet: [], network: [], security: [], legacy: [], externalAssets: [] };
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXT.has(ext) && !['package.json','Directory.Build.props'].includes(path.basename(file))) continue;
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    inspectText(auditRoot, file, text, report);
  }
  await inspectPackages(auditRoot, files, report);
  await inspectDotnet(auditRoot, files, report);
  report.summary = summarize(report);
  report.network.sort((a,b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
  report.security.sort((a,b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
  report.legacy.sort((a,b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
  return report;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const report = await runAudit(ROOT);
  const outDir = path.join(ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'platform-audit.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'platform-audit.md'), markdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
  if (args.has('--fail-on-critical') && report.security.some(x => x.severity === 'critical')) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error); process.exitCode = 1; });
