import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowCacheBoundaries } from './workflow-cache-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';
const PIN='0123456789abcdef0123456789abcdef01234567';
function audit(text:string){return auditWorkflowCacheBoundaries(fixtureInventory([{path:'.github/workflows/cache.yml',text}] as readonly FixtureFileInput[]));}
function workflow(step:string,permissions='contents: read'):string{return `name: cache\non: [push]\npermissions:\n  ${permissions}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${step.split('\n').map(line=>`      ${line}`).join('\n')}\n`;}
function cache(body:string,ref=PIN):string{return `- uses: actions/cache@${ref}\n  with:\n${body.split('\n').map(line=>`    ${line}`).join('\n')}`;}
test('accepts pinned cache with trusted content-addressed key',()=>{const result=audit(workflow(cache('path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles(\'**/package-lock.json\') }}')));assert.equal(result.findings.length,0);assert.equal(result.summary.cacheSteps,1);});
test('blocks mutable actions/cache ref',()=>{assert.ok(audit(workflow(cache('path: ~/.npm\nkey: npm-lock','v4'))).findings.some(item=>item.id==='ci-cache-action-mutable-ref'&&item.blocking));});
test('blocks attacker-controlled cache key',()=>{assert.ok(audit(workflow(cache('path: ~/.npm\nkey: npm-${{ github.event.pull_request.title }}'))).findings.some(item=>item.id==='ci-cache-key-untrusted-input'));});
test('blocks attacker-controlled cache path',()=>{assert.ok(audit(workflow(cache('path: ${{ github.event.pull_request.head.ref }}\nkey: npm-lock'))).findings.some(item=>item.id==='ci-cache-path-untrusted-input'));});
test('blocks git metadata cache',()=>{assert.ok(audit(workflow(cache('path: .git\nkey: repository-state'))).findings.some(item=>item.id==='ci-cache-sensitive-path'));});
test('blocks ssh credential cache',()=>{assert.ok(audit(workflow(cache('path: ~/.ssh\nkey: ssh-state'))).findings.some(item=>item.id==='ci-cache-sensitive-path'));});
test('blocks broad executable restore prefix in privileged workflow',()=>{assert.ok(audit(workflow(cache('path: node_modules\nkey: npm-${{ hashFiles(\'package-lock.json\') }}\nrestore-keys: |\n  npm-'),'contents: write')).findings.some(item=>item.id==='ci-cache-privileged-broad-executable-restore'));});
test('blocks attacker-controlled restore prefix in privileged workflow',()=>{assert.ok(audit(workflow(cache('path: ~/.npm\nkey: npm-lock\nrestore-keys: |\n  npm-${{ inputs.channel }}-'),'packages: write')).findings.some(item=>item.id==='ci-cache-privileged-untrusted-restore-prefix'));});
test('inspects restore and save subactions',()=>{for(const sub of ['restore','save']){const result=audit(workflow(`- uses: actions/cache/${sub}@${PIN}\n  with:\n    path: .git\n    key: repo`));assert.equal(result.summary.cacheSteps,1);assert.ok(result.findings.some(item=>item.id==='ci-cache-sensitive-path'));}});
test('does not inspect non-workflow YAML',()=>{const result=auditWorkflowCacheBoundaries(fixtureInventory([{path:'config/cache.yml',text:`uses: actions/cache@${PIN}`}] as readonly FixtureFileInput[]));assert.equal(result.summary.workflowFiles,0);});
