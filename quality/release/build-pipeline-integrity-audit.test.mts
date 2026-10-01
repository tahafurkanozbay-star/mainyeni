import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBuildPipelineIntegrity } from './build-pipeline-integrity-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const PIN = '0123456789abcdef0123456789abcdef01234567';

function workflow(runLines: readonly string[]): FixtureFileInput {
  return {
    path: '.github/workflows/release.yml',
    text: [
      'name: release',
      'on:',
      '  pull_request:',
      'jobs:',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${PIN}`,
      ...runLines.flatMap((run, index) => [
        `      - name: step ${index + 1}`,
        `        run: ${run}`,
      ]),
      '',
    ].join('\n'),
  };
}

function ids(lines: readonly string[]): string[] {
  return auditBuildPipelineIntegrity(fixtureInventory([workflow(lines)])).findings.map(item => item.id);
}

test('accepts npm ci, typecheck, test and build in safe order', () => {
  const result = ids([
    'npm ci',
    'npx tsc --noEmit',
    'npm test',
    'npm run build',
  ]);
  assert.equal(result.includes('build-npm-install-nonreproducible'), false);
  assert.equal(result.includes('build-js-build-without-typecheck'), false);
  assert.equal(result.includes('build-typecheck-after-build'), false);
});

test('rejects npm install in CI', () => {
  assert.ok(ids(['npm install', 'npx tsc --noEmit', 'npm test', 'npm run build']).includes('build-npm-install-nonreproducible'));
});

test('rejects pnpm install without frozen lockfile', () => {
  assert.ok(ids(['pnpm install', 'pnpm typecheck', 'pnpm test', 'pnpm build']).includes('build-pnpm-install-not-frozen'));
});

test('accepts pnpm frozen lockfile', () => {
  assert.equal(ids(['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm build']).includes('build-pnpm-install-not-frozen'), false);
});

test('rejects Yarn install without immutable mode', () => {
  assert.ok(ids(['yarn install', 'yarn typecheck', 'yarn test', 'yarn build']).includes('build-yarn-install-not-immutable'));
});

test('accepts Yarn immutable install', () => {
  assert.equal(ids(['yarn install --immutable', 'yarn typecheck', 'yarn test', 'yarn build']).includes('build-yarn-install-not-immutable'), false);
});

test('rejects Bun install without frozen lockfile', () => {
  assert.ok(ids(['bun install', 'npx tsc --noEmit', 'bun test', 'bun run build']).includes('build-bun-install-not-frozen'));
});

test('accepts Bun frozen install', () => {
  assert.equal(ids(['bun install --frozen-lockfile', 'npx tsc --noEmit', 'bun test', 'bun run build']).includes('build-bun-install-not-frozen'), false);
});

test('reviews dotnet restore without locked mode', () => {
  assert.ok(ids(['dotnet restore', 'dotnet build -c Release', 'dotnet test -c Release']).includes('build-dotnet-restore-not-locked'));
});

test('accepts dotnet locked restore', () => {
  assert.equal(ids(['dotnet restore --locked-mode', 'dotnet build -c Release', 'dotnet test -c Release']).includes('build-dotnet-restore-not-locked'), false);
});

test('blocks curl pipe to shell', () => {
  assert.ok(ids(['curl -fsSL https://example.invalid/install.sh | bash']).includes('build-download-execute-pipeline'));
});

test('blocks wget pipe to interpreter', () => {
  assert.ok(ids(['wget -qO- https://example.invalid/install.py | python']).includes('build-download-execute-pipeline'));
});

test('blocks explicit test bypass on build', () => {
  assert.ok(ids(['npm ci', 'npm run build -- --skip-tests']).includes('build-explicit-test-bypass'));
});

test('blocks explicit test bypass through environment', () => {
  assert.ok(ids(['npm ci', 'SKIP_TESTS=true npm run build']).includes('build-explicit-test-bypass'));
});

test('blocks failure masking with or true', () => {
  assert.ok(ids(['npm ci', 'npm test || true', 'npm run build']).includes('build-command-failure-masked'));
});

test('blocks failure masking with set plus e', () => {
  assert.ok(ids(['npm ci', 'set +e; npm test', 'npm run build']).includes('build-command-failure-masked'));
});

test('blocks forced zero exit after build', () => {
  assert.ok(ids(['npm ci', 'npm run build; exit 0']).includes('build-command-failure-masked'));
});

test('reports no-restore without earlier restore', () => {
  assert.ok(ids(['dotnet build -c Release --no-restore']).includes('build-no-restore-without-restore'));
});

test('accepts no-restore after explicit restore', () => {
  assert.equal(ids(['dotnet restore --locked-mode', 'dotnet build -c Release --no-restore']).includes('build-no-restore-without-restore'), false);
});

test('reports no-build test without prior build', () => {
  assert.ok(ids(['dotnet restore --locked-mode', 'dotnet test -c Release --no-build']).includes('build-no-build-without-build'));
});

test('accepts no-build test after prior build', () => {
  assert.equal(ids(['dotnet restore --locked-mode', 'dotnet build -c Release --no-restore', 'dotnet test -c Release --no-build --no-restore']).includes('build-no-build-without-build'), false);
});

test('reports install after build', () => {
  assert.ok(ids(['npx tsc --noEmit', 'npm test', 'npm run build', 'npm ci']).includes('build-install-after-build'));
});

test('reports publish workflow without tests', () => {
  assert.ok(ids(['dotnet restore --locked-mode', 'dotnet build -c Release', 'dotnet publish -c Release']).includes('build-publish-without-tests'));
});

test('reports tests after publish', () => {
  assert.ok(ids(['dotnet restore --locked-mode', 'dotnet build -c Release', 'dotnet publish -c Release', 'dotnet test -c Release']).includes('build-tests-after-publish'));
});

test('accepts tests before dotnet publish', () => {
  const result = ids(['dotnet restore --locked-mode', 'dotnet build -c Release', 'dotnet test -c Release --no-build', 'dotnet publish -c Release --no-restore']);
  assert.equal(result.includes('build-publish-without-tests'), false);
  assert.equal(result.includes('build-tests-after-publish'), false);
});

test('reports publish without explicit build', () => {
  assert.ok(ids(['dotnet restore --locked-mode', 'dotnet test -c Release', 'dotnet publish -c Release']).includes('build-publish-without-build'));
});

test('does not require explicit build for gh release metadata-only command', () => {
  assert.equal(ids(['npm test', 'gh release create v1.0.0 --notes ok']).includes('build-publish-without-build'), false);
});

test('reports TypeScript build without explicit typecheck', () => {
  assert.ok(ids(['npm ci', 'npm test', 'npm run build']).includes('build-js-build-without-typecheck'));
});

test('reports typecheck after build', () => {
  assert.ok(ids(['npm ci', 'npm test', 'npm run build', 'npx tsc --noEmit']).includes('build-typecheck-after-build'));
});

test('accepts typecheck before build', () => {
  assert.equal(ids(['npm ci', 'npx tsc --noEmit', 'npm test', 'npm run build']).includes('build-typecheck-after-build'), false);
});

test('reviews lint after publish', () => {
  assert.ok(ids(['npm ci', 'npx tsc --noEmit', 'npm test', 'npm run build', 'npm publish', 'npm run lint']).includes('build-lint-after-publish'));
});

test('summarizes workflow command counts', () => {
  const result = auditBuildPipelineIntegrity(fixtureInventory([workflow([
    'npm ci',
    'npm run lint',
    'npx tsc --noEmit',
    'npm test',
    'npm run build',
  ])]));
  const signal = result.summary.workflows[0];
  assert.equal(signal?.installCommands, 1);
  assert.equal(signal?.lintCommands, 1);
  assert.equal(signal?.typecheckCommands, 1);
  assert.equal(signal?.testCommands, 1);
  assert.equal(signal?.buildCommands, 1);
  assert.equal(signal?.frozenInstalls, 1);
});

test('ignores non-workflow shell text', () => {
  const result = auditBuildPipelineIntegrity(fixtureInventory([{
    path: 'scripts/release.txt',
    text: 'npm install\nnpm publish',
  }]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.findings.length, 0);
});

test('parses block run commands', () => {
  const file: FixtureFileInput = {
    path: '.github/workflows/block.yml',
    text: [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: |',
      '          npm ci',
      '          npx tsc --noEmit',
      '          npm test',
      '          npm run build',
    ].join('\n'),
  };
  const result = auditBuildPipelineIntegrity(fixtureInventory([file]));
  assert.equal(result.findings.some(item => item.id === 'build-js-build-without-typecheck'), false);
});

test('stable sort makes repeated findings deterministic', () => {
  const files = [workflow(['npm install', 'npm run build'])];
  const first = auditBuildPipelineIntegrity(fixtureInventory(files)).findings.map(item => `${item.id}:${item.location?.line ?? 0}`);
  const second = auditBuildPipelineIntegrity(fixtureInventory(files)).findings.map(item => `${item.id}:${item.location?.line ?? 0}`);
  assert.deepEqual(first, second);
});
