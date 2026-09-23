import test from 'node:test';
import assert from 'node:assert/strict';
import { auditVerifyChain, REQUIRED_VERIFY_CHAIN } from './release-evidence-audit.mjs';

const canonical = REQUIRED_VERIFY_CHAIN.map((name) => `npm run ${name}`).join(' && ');
const codes = (command) => new Set(auditVerifyChain(command).map((item) => item.code));

test('canonical fail-fast verify chain passes', () => {
  assert.deepEqual(auditVerifyChain(canonical), []);
});

test('approved npm quality gates may run between mandatory gates', () => {
  const command = canonical
    .replace('npm run dependency:verify &&', 'npm run dependency:verify && npm run quality:module-graph && npm run quality:language-ratchet &&')
    .replace('npm run lint:strict &&', 'npm run lint:strict && npm run quality:experience && npm run quality:vite &&');
  assert.deepEqual(auditVerifyChain(command), []);
});

test('logical OR cannot turn a required gate into best effort', () => {
  assert.ok(codes(canonical.replace(' && npm run typecheck', ' || npm run typecheck')).has('verify-chain-unsafe-operator'));
});

test('semicolon cannot detach a required gate from fail-fast execution', () => {
  assert.ok(codes(canonical.replace(' && npm run test:ci', '; npm run test:ci')).has('verify-chain-unsafe-operator'));
});

test('pipeline cannot mask a required gate status', () => {
  assert.ok(codes(canonical.replace('npm run typecheck', 'npm run typecheck | cat')).has('verify-chain-unsafe-operator'));
});

test('command substitution is rejected', () => {
  assert.ok(codes(canonical.replace('npm run typecheck', '$(npm run typecheck)')).has('verify-chain-unsafe-operator'));
});

test('backtick command substitution is rejected', () => {
  assert.ok(codes(canonical.replace('npm run typecheck', '`npm run typecheck`')).has('verify-chain-unsafe-operator'));
});

test('wrapper shell command is rejected', () => {
  assert.ok(codes(canonical.replace('npm run typecheck', 'sh -c "npm run typecheck"')).has('verify-chain-unexpected-command'));
});

test('force-success suffix is rejected', () => {
  const findings = auditVerifyChain(canonical.replace('npm run typecheck', 'npm run typecheck || true'));
  assert.ok(findings.some((item) => item.code === 'verify-chain-unsafe-operator'));
});

test('arguments cannot mutate required npm script semantics', () => {
  assert.ok(codes(canonical.replace('npm run typecheck', 'npm run typecheck -- --pretty false')).has('verify-chain-unexpected-command'));
});

test('duplicate mandatory gate fails closed', () => {
  const command = canonical.replace('npm run typecheck', 'npm run typecheck && npm run typecheck');
  assert.ok(codes(command).has('verify-chain-gap'));
});

test('missing mandatory gate fails closed', () => {
  const command = canonical.replace(' && npm run test:ci', '');
  assert.ok(codes(command).has('verify-chain-gap'));
});

test('mandatory gates cannot be reordered', () => {
  const command = canonical
    .replace('npm run typecheck', '__TYPECHECK__')
    .replace('npm run test:ci', 'npm run typecheck')
    .replace('__TYPECHECK__', 'npm run test:ci');
  assert.ok(codes(command).has('verify-chain-order'));
});

test('newline injection is rejected', () => {
  assert.ok(codes(canonical.replace(' && npm run typecheck', '\nnpm run typecheck')).has('verify-chain-unsafe-operator'));
});

test('single ampersand background execution is rejected', () => {
  assert.ok(codes(canonical.replace(' && npm run typecheck', ' & npm run typecheck')).has('verify-chain-unsafe-operator'));
});

test('empty verify command fails closed', () => {
  assert.ok(codes('').has('verify-chain-empty'));
});

test('whitespace-only verify command fails closed', () => {
  assert.ok(codes('   ').has('verify-chain-empty'));
});
