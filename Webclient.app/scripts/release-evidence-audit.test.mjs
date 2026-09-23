import test from 'node:test';
import assert from 'node:assert/strict';
import { auditPackage, auditWorkflow, auditReleaseEvidence, formatFindings, summarize, runSelfTest, REQUIRED_PACKAGE_SCRIPTS, REQUIRED_WORKFLOW_STEPS } from './release-evidence-audit.mjs';

function packageFixture(overrides={}) {
  const scripts=Object.fromEntries(REQUIRED_PACKAGE_SCRIPTS.map(name=>[name,`node ${name}.mjs`]));
  scripts.verify='npm run dependency:verify && npm run lint:strict && npm run typecheck && npm run test:ci && npm run test:tooling && npm run test:build-budget && npm run build && npm run build:verify';
  scripts['test:tooling']='node --test scripts/release-evidence-audit.test.mjs';
  return JSON.stringify({private:true,type:'module',engines:{node:'>=24.0.0',npm:'>=11.0.0'},scripts,...overrides});
}
function workflowFixture(extra='') {
  return `name: Webclient Quality\npermissions:\n  contents: read\nconcurrency:\n  cancel-in-progress: true\njobs:\n  quality:\n    steps:\n      - name: Setup Node 24\n        with:\n          node-version: 24\n      - name: Install from lockfile\n        run: npm ci\n      - name: Baseline\n        env:\n          BASE_SHA: \${{ github.event.pull_request.base.sha }}\n        run: |\n          git -C .. worktree add --detach /tmp/base "$BASE_SHA"\n          trap 'git -C .. worktree remove --force /tmp/base' EXIT\n${REQUIRED_WORKFLOW_STEPS.filter(name=>name!=='Install from lockfile').map(name=>`      - name: ${name}\n        run: echo ok`).join('\n')}\n${extra}`;
}
function codes(items){ return new Set(items.map(item=>item.code)); }

test('self-test proves positive and negative fixtures',()=>assert.equal(runSelfTest(),true));
test('valid package has no package errors',()=>assert.deepEqual(auditPackage(packageFixture()),[]));
test('invalid JSON fails closed',()=>assert.ok(codes(auditPackage('{')).has('package-json-invalid')));
test('package must remain private',()=>assert.ok(codes(auditPackage(packageFixture({private:false}))).has('package-must-be-private')));
test('package must remain ESM',()=>assert.ok(codes(auditPackage(packageFixture({type:'commonjs'}))).has('package-module-contract')));
test('missing required scripts are all reported',()=>{const result=auditPackage(JSON.stringify({private:true,type:'module',engines:{node:'>=24',npm:'>=11'},scripts:{verify:''}}));assert.equal(result.filter(x=>x.code==='required-script-missing').length,REQUIRED_PACKAGE_SCRIPTS.length)});
test('verify chain detects missing dependency verification',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run dependency:verify && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing strict lint',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run lint:strict && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing typecheck',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run typecheck && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing vitest',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run test:ci && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing tooling tests',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run test:tooling && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing build budget tests',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run test:build-budget && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing build',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace('npm run build && ','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('verify chain detects missing build verification',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts.verify=pkg.scripts.verify.replace(' && npm run build:verify','');assert.ok(codes(auditPackage(JSON.stringify(pkg))).has('verify-chain-gap'))});
test('node engine rejects pre-24 floor',()=>assert.ok(codes(auditPackage(packageFixture({engines:{node:'>=22',npm:'>=11'}}))).has('node-engine-drift')));
test('npm engine rejects pre-11 floor',()=>assert.ok(codes(auditPackage(packageFixture({engines:{node:'>=24',npm:'>=10'}}))).has('npm-engine-drift')));
test('valid workflow has no workflow errors',()=>assert.deepEqual(auditWorkflow(workflowFixture()).filter(x=>x.severity==='error'),[]));
test('read-only workflow permission is mandatory',()=>assert.ok(codes(auditWorkflow(workflowFixture().replace('contents: read','contents: write'))).has('workflow-permissions')));
test('concurrency cancellation absence is visible',()=>assert.ok(codes(auditWorkflow(workflowFixture().replace('cancel-in-progress: true','cancel-in-progress: false'))).has('workflow-concurrency')));
test('node latest is rejected',()=>{const text=workflowFixture().replace('node-version: 24','node-version: latest');const c=codes(auditWorkflow(text));assert.ok(c.has('workflow-node-version'));assert.ok(c.has('forbidden-unpinned-node-major'))});
test('npm install is rejected',()=>{const text=workflowFixture().replace('run: npm ci','run: npm install');const c=codes(auditWorkflow(text));assert.ok(c.has('lockfile-install'));assert.ok(c.has('forbidden-npm-install'))});
test('continue-on-error is rejected',()=>assert.ok(codes(auditWorkflow(workflowFixture('\ncontinue-on-error: true'))).has('forbidden-continue-on-error')));
test('npm audit low threshold remains an active audit',()=>assert.ok(!codes(auditWorkflow(workflowFixture('\nrun: npm audit --omit=dev --audit-level=low'))).has('forbidden-audit-disabled')));
test('npm audit success bypass is rejected',()=>assert.ok(codes(auditWorkflow(workflowFixture('\nrun: npm audit --omit=dev --audit-level=high || true'))).has('forbidden-audit-disabled')));
test('every required workflow step is independently guarded',()=>{for(const name of REQUIRED_WORKFLOW_STEPS){const text=workflowFixture().replace(`- name: ${name}`,`- name: removed-${name}`);assert.ok(auditWorkflow(text).some(x=>x.code==='required-step-missing'&&x.evidence===name),name)}});
test('exact PR base SHA is mandatory',()=>assert.ok(codes(auditWorkflow(workflowFixture().replaceAll('github.event.pull_request.base.sha','github.sha'))).has('exact-base-source')));
test('detached worktree isolation is mandatory',()=>assert.ok(codes(auditWorkflow(workflowFixture().replace('worktree add --detach','worktree add'))).has('baseline-worktree')));
test('baseline cleanup trap is mandatory',()=>assert.ok(codes(auditWorkflow(workflowFixture().replace("trap 'git -C .. worktree remove --force /tmp/base' EXIT",'echo no-cleanup'))).has('baseline-cleanup')));
test('regression gates must precede production build',()=>{const text=workflowFixture();const a='- name: Exact-base Vitest regression gate\n        run: echo ok';const b='- name: Production Vite build and integrity manifest\n        run: echo ok';const marker='- name: __BUILD_MARKER__\n        run: echo ok';const reordered=text.replace(b,marker).replace(a,b).replace(marker,a);assert.ok(codes(auditWorkflow(reordered)).has('regression-gate-order'))});
test('tooling audit must be wired into tooling suite',()=>{const pkg=JSON.parse(packageFixture());pkg.scripts['test:tooling']='node --test scripts/other.test.mjs';assert.ok(codes(auditReleaseEvidence({packageText:JSON.stringify(pkg),workflowText:workflowFixture()})).has('audit-self-test-not-wired'))});
test('summary marks error findings failed',()=>{const s=summarize([{severity:'error'},{severity:'warning'}]);assert.equal(s.passed,false);assert.equal(s.error,1);assert.equal(s.warning,1);assert.equal(s.total,2)});
test('summary allows warnings without failing',()=>assert.equal(summarize([{severity:'warning'}]).passed,true));
test('formatter is deterministic and human readable',()=>{const output=formatFindings([{severity:'error',code:'x',file:'a',line:4,message:'bad',evidence:'z'}]);assert.match(output,/FAIL/);assert.match(output,/ERROR x a:4/);assert.match(output,/\[z\]/)});
test('combined audit orders errors before warnings',()=>{const findings=auditReleaseEvidence({packageText:packageFixture(),workflowText:workflowFixture().replace('cancel-in-progress: true','cancel-in-progress: false')});assert.equal(findings.at(-1).severity,'warning')});
