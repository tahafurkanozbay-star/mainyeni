import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPackageScriptInvocations } from './dependency-surface-policy.mjs';

test('Deno package script sources must be local reviewed files', () => {
  for (const command of [
    'deno run https://example.test/module.ts',
    'deno run ../outside.ts',
    'deno test /tmp/check.test.ts',
    'deno run --config scripts/check.ts',
  ]) {
    assert.throws(
      () => collectPackageScriptInvocations(command),
      (error) => error.code === 'unreviewed-runtime-execution-script',
      command,
    );
  }
});

test('Deno package script local entrypoints remain supported', () => {
  for (const command of [
    'deno run scripts/check.ts',
    'deno run --config ./deno.json scripts/check.ts',
    'deno test --filter smoke scripts/check.test.ts',
  ]) {
    assert.ok(collectPackageScriptInvocations(command).length > 0, command);
  }
});
