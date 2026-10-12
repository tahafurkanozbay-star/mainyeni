import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAsyncResourceLifecycle } from './async-resource-lifecycle-audit.mts';
import { auditCSharpModernizationContracts } from './csharp-modernization-contract-audit.mts';
import { auditModuleGraphModernization } from './module-graph-modernization-audit.mts';
import {
  MIN_MEANINGFUL_ADDITIONS,
  REQUIRED_CHECKS,
  evaluateReleaseCandidate,
} from './release-candidate-gate.mts';
import {
  DEFAULT_REQUIRED,
  evaluateReleaseEvidenceQuorum,
} from './release-evidence-quorum.mts';
import { evaluateReleaseAdmissionSnapshot } from './release-admission-snapshot.mts';
import { auditToolingLanguageRatchet } from './tooling-language-ratchet-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OBSERVED_AT = '2026-10-12T05:00:00.000Z';

function successfulRuns() {
  return DEFAULT_REQUIRED.map((name, index) => ({
    name,
    headSha: HEAD,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    runId: 1000 + index,
    attempt: 1,
    createdAt: '2026-10-12T04:40:00.000Z',
    updatedAt: '2026-10-12T04:50:00.000Z',
  }));
}

function candidate(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    version: 1,
    baseSha: MAIN,
    headSha: HEAD,
    mergeBaseSha: MAIN,
    currentMainSha: MAIN,
    additions: MIN_MEANINGFUL_ADDITIONS,
    deletions: 0,
    aheadBy: 8,
    behindBy: 0,
    unresolvedThreads: 0,
    mergeable: true,
    draft: false,
    checks: REQUIRED_CHECKS.map(name => ({
      name,
      status: 'completed',
      conclusion: 'success',
      headSha: HEAD,
    })),
    ...overrides,
  };
}

function snapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    version: 1,
    main: { headSha: MAIN, ref: 'main' },
    pullRequest: {
      baseSha: MAIN,
      headSha: HEAD,
      baseRef: 'main',
      headRef: 'agent/qa-modernization',
      draft: false,
      mergeable: true,
      additions: MIN_MEANINGFUL_ADDITIONS,
      deletions: 0,
    },
    compare: {
      baseSha: MAIN,
      headSha: HEAD,
      mergeBaseSha: MAIN,
      aheadBy: 8,
      behindBy: 0,
      status: 'ahead',
    },
    reviewThreads: [],
    workflowRuns: successfulRuns(),
    observedAt: OBSERVED_AT,
    maxEvidenceAgeMs: 60 * 60 * 1000,
    ...overrides,
  };
}

test('typed release candidate authority accepts a fully verified merge candidate', () => {
  const result = evaluateReleaseCandidate(candidate());
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.summary.requiredChecks, REQUIRED_CHECKS);
});

test('typed release candidate authority keeps additions as an additions-only gate', () => {
  const result = evaluateReleaseCandidate(candidate({
    additions: MIN_MEANINGFUL_ADDITIONS - 1,
    deletions: 100_000,
  }));
  assert.equal(result.passed, false);
  assert.ok(result.findings.some(item => item.code === 'additions-gate'));
});

test('typed quorum accepts fresh exact-head pull-request evidence', () => {
  const result = evaluateReleaseEvidenceQuorum({
    version: 1,
    headSha: HEAD,
    baseSha: MAIN,
    currentMainSha: MAIN,
    runs: successfulRuns(),
    observedAt: OBSERVED_AT,
    maxEvidenceAgeMs: 60 * 60 * 1000,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.summary.required, DEFAULT_REQUIRED);
});

test('typed quorum rejects a successful check from another head', () => {
  const runs = successfulRuns();
  runs[0] = { ...runs[0]!, headSha: 'c'.repeat(40) };
  const result = evaluateReleaseEvidenceQuorum({
    version: 1,
    headSha: HEAD,
    baseSha: MAIN,
    currentMainSha: MAIN,
    runs,
    observedAt: OBSERVED_AT,
    maxEvidenceAgeMs: 60 * 60 * 1000,
  });
  assert.equal(result.passed, false);
  assert.ok(result.findings.some(item => item.code === 'required-run-missing'));
});

test('typed admission snapshot composes lineage, review and workflow authorities', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot());
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.candidate?.mergeAllowed, true);
  assert.equal(result.workflow?.passed, true);
  assert.equal(result.summary.reviewThreads, 0);
});

test('typed admission snapshot rejects unresolved review threads', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot({
    reviewThreads: [{ id: 'thread-1', resolved: false }],
  }));
  assert.equal(result.passed, false);
  assert.equal(result.mergeAllowed, false);
  assert.ok(result.findings.some(item => item.code === 'candidate-review-threads'));
});

test('typed admission snapshot rejects stale main authority', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot({
    main: { headSha: 'c'.repeat(40), ref: 'main' },
  }));
  assert.equal(result.passed, false);
  assert.ok(result.findings.some(item => item.code === 'pr-base-stale'));
  assert.ok(result.findings.some(item => item.code === 'compare-base-stale'));
});

test('modern runtime fixtures satisfy async resource ownership audit', () => {
  const inventory = fixtureInventory([{
    path: 'Webclient.app/src/ModernRuntime.ts',
    text: `
      export class ModernRuntime {
        private readonly observer = new ResizeObserver(() => {});
        private readonly controller = new AbortController();
        private frame = 0;
        start() {
          this.observer.observe(document.body);
          this.frame = requestAnimationFrame(() => {});
          return fetch('/api/state', { signal: this.controller.signal });
        }
        dispose() {
          this.observer.disconnect();
          this.controller.abort();
          cancelAnimationFrame(this.frame);
        }
      }
    `,
  }]);
  const result = auditAsyncResourceLifecycle(inventory);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.observerResources, 1);
  assert.equal(result.summary.abortControllers, 1);
});

test('modern typed product graph remains acyclic and legacy-free', () => {
  const inventory = fixtureInventory([
    {
      path: 'Webclient.app/src/app.ts',
      text: "import { query } from './query.ts'; export const app = query;",
    },
    {
      path: 'Webclient.app/src/query.ts',
      text: 'export const query = { enabled: true };',
    },
  ]);
  const result = auditModuleGraphModernization(inventory);
  assert.equal(result.summary.legacyFiles, 0);
  assert.equal(result.summary.unresolvedRelativeImports, 0);
  assert.equal(result.summary.cycles.length, 0);
  assert.equal(result.findings.length, 0);
});

test('modern CSharp fixture keeps async and transport ownership compiler-visible', () => {
  const inventory = fixtureInventory([
    {
      path: 'Directory.Build.props',
      text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>annotations</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><AnalysisLevel>latest</AnalysisLevel><Deterministic>true</Deterministic><RestoreAuditMode>all</RestoreAuditMode><RestoreAuditLevel>moderate</RestoreAuditLevel></PropertyGroup></Project>',
    },
    {
      path: 'Business/QueryService.cs',
      text: `
        public sealed class QueryService {
          private readonly IHttpClientFactory factory;
          public QueryService(IHttpClientFactory factory) => this.factory = factory;
          public async Task<string> RunAsync(CancellationToken cancellationToken) {
            using var client = factory.CreateClient("query");
            return await client.GetStringAsync("/api/query", cancellationToken);
          }
        }
      `,
    },
  ]);
  const result = auditCSharpModernizationContracts(inventory);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.compiler.targetFramework, 'net10.0');
  assert.equal(result.summary.compiler.languageVersion, '14.0');
});

test('legacy tooling ratchet accepts typed compatibility shims but not new policy code', () => {
  const inventory = fixtureInventory([
    {
      path: 'quality/release/tooling-language-baseline.json',
      text: JSON.stringify({
        schemaVersion: 1,
        description: 'integration',
        productionLegacy: [],
        testLegacy: [],
      }),
    },
    {
      path: 'Webclient.app/scripts/release-candidate-gate.mjs',
      text: "export * from '../../quality/release/release-candidate-gate.mts';",
    },
  ]);
  const result = auditToolingLanguageRatchet(inventory);
  assert.equal(result.summary.compatibilityShims, 1);
  assert.equal(result.summary.productionLegacy, 0);
  assert.equal(result.findings.length, 0);
});

test('legacy tooling ratchet blocks a new untyped release policy authority', () => {
  const inventory = fixtureInventory([
    {
      path: 'quality/release/tooling-language-baseline.json',
      text: JSON.stringify({
        schemaVersion: 1,
        description: 'integration',
        productionLegacy: [],
        testLegacy: [],
      }),
    },
    {
      path: 'Webclient.app/scripts/new-release-policy.mjs',
      text: 'export function evaluate(input) { return input?.ok === true; }',
    },
  ]);
  const result = auditToolingLanguageRatchet(inventory);
  const finding = result.findings.find(item => item.id === 'tooling-language-new-legacy-production');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('modernization authorities are deterministic across repeated execution', () => {
  const files: readonly FixtureFileInput[] = [
    {
      path: 'Webclient.app/src/a.ts',
      text: "import { b } from './b.ts'; export const a = b;",
    },
    {
      path: 'Webclient.app/src/b.ts',
      text: 'export const b = 1;',
    },
  ];
  const inventory = fixtureInventory(files);
  const first = auditModuleGraphModernization(inventory);
  const second = auditModuleGraphModernization(inventory);
  assert.deepEqual(first.summary.imports, second.summary.imports);
  assert.deepEqual(first.findings, second.findings);
});
