import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '..');

export const REQUIRED_PACKAGE_SCRIPTS = Object.freeze([
  'dependency:verify','lint','lint:strict','typecheck','test:ci','test:tooling','test:build-budget','build','build:verify',
  'quality:experience','quality:vite','quality:gis-query-governance','quality:spatial-selection-index','quality:kent-rehberi-all-layers',
]);

export const REQUIRED_WORKFLOW_STEPS = Object.freeze([
  'Verify toolchain contract','Install from lockfile','Dependency and lockfile contract','Production dependency audit',
  'Full lint visibility','Strict lint on changed Webclient sources','Full TypeScript diagnostic visibility',
  'Exact-base TypeScript regression gate','Full Vitest diagnostic visibility','Exact-base Vitest regression gate',
  'Native tooling regression suite','Build budget script tests','Production Vite build and integrity manifest',
  'Verify production bundle integrity','Enforce production build budgets',
]);

export const FORBIDDEN_WORKFLOW_PATTERNS = Object.freeze([
  { id: 'continue-on-error', regex: /continue-on-error\s*:\s*true/i },
  { id: 'npm-install', regex: /(?:^|\s)npm\s+install(?:\s|$)/im },
  { id: 'unpinned-node-major', regex: /node-version\s*:\s*['\"]?(?:latest|current|lts\/?\*)/i },
  { id: 'audit-disabled', regex: /npm\s+audit[^\n]*(?:--audit-level=(?:none|low)|\|\|\s*true)/i },
  { id: 'force-success', regex: /(?:^|\s)(?:exit\s+0|true)\s*(?:#.*)?$/im },
]);

function read(file) { return fs.readFileSync(file, 'utf8'); }
function lines(text) { return text.split(/\r?\n/); }
function occurrenceLines(text, regex) {
  const out = [];
  for (const [index, line] of lines(text).entries()) {
    regex.lastIndex = 0;
    if (regex.test(line)) out.push(index + 1);
  }
  return out;
}
function finding(severity, code, message, file, line = null, evidence = null) {
  return Object.freeze({ severity, code, message, file, line, evidence });
}
function stableSort(findings) {
  const rank = { error: 0, warning: 1, info: 2 };
  return [...findings].sort((a,b) => (rank[a.severity]-rank[b.severity]) || a.file.localeCompare(b.file) || ((a.line ?? 0)-(b.line ?? 0)) || a.code.localeCompare(b.code));
}

export function auditPackage(packageText, file='Webclient.app/package.json') {
  const findings=[];
  let pkg;
  try { pkg=JSON.parse(packageText); } catch (error) { return [finding('error','package-json-invalid',String(error?.message ?? error),file)]; }
  if (pkg.private !== true) findings.push(finding('error','package-must-be-private','Webclient release package must remain private.',file));
  if (pkg.type !== 'module') findings.push(finding('error','package-module-contract','Webclient tooling requires native ESM package mode.',file));
  const scripts=pkg.scripts ?? {};
  for (const name of REQUIRED_PACKAGE_SCRIPTS) if (typeof scripts[name] !== 'string' || !scripts[name].trim()) findings.push(finding('error','required-script-missing',`Required release script is missing: ${name}`,file,null,name));
  const verify=String(scripts.verify ?? '');
  for (const name of ['dependency:verify','lint:strict','typecheck','test:ci','test:tooling','test:build-budget','build','build:verify']) {
    if (!verify.includes(`npm run ${name}`)) findings.push(finding('error','verify-chain-gap',`verify does not execute ${name}.`,file,null,name));
  }
  const node=String(pkg.engines?.node ?? '');
  const npm=String(pkg.engines?.npm ?? '');
  if (!/>=\s*24/.test(node)) findings.push(finding('error','node-engine-drift','Node engine must require Node 24 or newer.',file,null,node));
  if (!/>=\s*11/.test(npm)) findings.push(finding('error','npm-engine-drift','npm engine must require npm 11 or newer.',file,null,npm));
  return findings;
}

export function auditWorkflow(workflowText, file='.github/workflows/webclient-quality.yml') {
  const findings=[];
  for (const step of REQUIRED_WORKFLOW_STEPS) {
    const escaped=step.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if (!new RegExp(`name:\\s*${escaped}(?:\\s*$|\\r?$)`,'m').test(workflowText)) findings.push(finding('error','required-step-missing',`Required quality step is missing: ${step}`,file,null,step));
  }
  if (!/permissions:\s*\n\s*contents:\s*read/m.test(workflowText)) findings.push(finding('error','workflow-permissions','Quality workflow must explicitly use read-only contents permission.',file));
  if (!/cancel-in-progress:\s*true/.test(workflowText)) findings.push(finding('warning','workflow-concurrency','Quality workflow should cancel superseded in-progress runs.',file));
  if (!/node-version:\s*24/.test(workflowText)) findings.push(finding('error','workflow-node-version','Quality workflow must execute on Node 24.',file));
  if (!/(?:^|\s)npm\s+ci(?:\s|$)/m.test(workflowText)) findings.push(finding('error','lockfile-install','Quality workflow must install with npm ci.',file));
  for (const rule of FORBIDDEN_WORKFLOW_PATTERNS) {
    if (rule.id === 'force-success') continue; // handled contextually below; visibility steps intentionally exit 0.
    for (const line of occurrenceLines(workflowText,rule.regex)) findings.push(finding('error',`forbidden-${rule.id}`,`Forbidden workflow pattern: ${rule.id}`,file,line,lines(workflowText)[line-1].trim()));
  }
  const baseType=workflowText.indexOf('Exact-base TypeScript regression gate');
  const baseTest=workflowText.indexOf('Exact-base Vitest regression gate');
  const build=workflowText.indexOf('Production Vite build and integrity manifest');
  if (baseType < 0 || baseTest < 0 || build < 0 || !(baseType < baseTest && baseTest < build)) findings.push(finding('error','regression-gate-order','Exact-base type/test gates must execute before production build.',file));
  if (!/github\.event\.pull_request\.base\.sha/.test(workflowText)) findings.push(finding('error','exact-base-source','PR regression gates must derive baseline from pull_request.base.sha.',file));
  if (!/worktree add --detach/.test(workflowText)) findings.push(finding('error','baseline-worktree','Regression gate must isolate exact base in a detached worktree.',file));
  if (!/trap ['\"]git -C \.\. worktree remove --force/.test(workflowText)) findings.push(finding('error','baseline-cleanup','Regression baseline worktree must be cleaned on failure.',file));
  return findings;
}

export function auditToolingTests(packageText,file='Webclient.app/package.json') {
  let pkg;
  try { pkg=JSON.parse(packageText); } catch { return []; }
  const command=String(pkg.scripts?.['test:tooling'] ?? '');
  if (!command.includes('release-evidence-audit.test.mjs')) return [finding('error','audit-self-test-not-wired','Release evidence audit tests must be part of test:tooling.',file,null,'release-evidence-audit.test.mjs')];
  return [];
}

export function summarize(findings) {
  const counts={error:0,warning:0,info:0};
  for (const item of findings) counts[item.severity]=(counts[item.severity] ?? 0)+1;
  return Object.freeze({ ...counts, total: findings.length, passed: counts.error === 0 });
}

export function auditReleaseEvidence({ packageText, workflowText }) {
  return stableSort([...auditPackage(packageText),...auditWorkflow(workflowText),...auditToolingTests(packageText)]);
}

export function formatFindings(findings) {
  const summary=summarize(findings);
  const output=[`Release evidence audit: ${summary.passed ? 'PASS' : 'FAIL'} (${summary.error} errors, ${summary.warning} warnings)`];
  for (const item of findings) output.push(`${item.severity.toUpperCase()} ${item.code} ${item.file}${item.line ? `:${item.line}` : ''} — ${item.message}${item.evidence ? ` [${item.evidence}]` : ''}`);
  return output.join('\n');
}

export function runSelfTest() {
  const goodPackage=JSON.stringify({private:true,type:'module',engines:{node:'>=24.0.0',npm:'>=11.0.0'},scripts:Object.fromEntries([...REQUIRED_PACKAGE_SCRIPTS.map(name=>[name,'ok']),['verify','npm run dependency:verify && npm run lint:strict && npm run typecheck && npm run test:ci && npm run test:tooling && npm run test:build-budget && npm run build && npm run build:verify'],['test:tooling','node --test release-evidence-audit.test.mjs']])});
  const goodWorkflow=`permissions:\n  contents: read\nconcurrency:\n  cancel-in-progress: true\nnode-version: 24\nrun: npm ci\nBASE_SHA: \${{ github.event.pull_request.base.sha }}\nrun: git -C .. worktree add --detach /tmp/base "$BASE_SHA"\ntrap 'git -C .. worktree remove --force /tmp/base' EXIT\n${REQUIRED_WORKFLOW_STEPS.map(name=>`- name: ${name}`).join('\n')}\n`;
  const findings=auditReleaseEvidence({packageText:goodPackage,workflowText:goodWorkflow});
  if (findings.some(item=>item.severity==='error')) throw new Error(`self-test fixture unexpectedly failed:\n${formatFindings(findings)}`);
  const bad=auditReleaseEvidence({packageText:'{"private":false,"type":"commonjs","scripts":{}}',workflowText:'permissions:\n  contents: write\nnode-version: latest\nnpm install\ncontinue-on-error: true'});
  const codes=new Set(bad.map(item=>item.code));
  for (const code of ['package-must-be-private','package-module-contract','required-script-missing','workflow-permissions','workflow-node-version','lockfile-install','forbidden-continue-on-error','forbidden-npm-install','forbidden-unpinned-node-major','regression-gate-order','exact-base-source','baseline-worktree','baseline-cleanup']) if (!codes.has(code)) throw new Error(`self-test did not detect ${code}`);
  return true;
}

function main() {
  const args=new Set(process.argv.slice(2));
  if (args.has('--self-test')) { runSelfTest(); console.log('Release evidence audit self-test: PASS'); return; }
  const packageText=read(path.join(ROOT,'package.json'));
  const workflowText=read(path.join(REPO,'.github','workflows','webclient-quality.yml'));
  const findings=auditReleaseEvidence({packageText,workflowText});
  console.log(formatFindings(findings));
  if (args.has('--strict') && findings.some(item=>item.severity==='error')) process.exitCode=1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
