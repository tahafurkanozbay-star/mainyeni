import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type TestContract,
  type TestCoverageSummary,
} from './contracts.mts';

export const RELEASE_TEST_CONTRACTS: readonly TestContract[] = Object.freeze([
  {
    id: 'gis-icon-registry',
    area: 'icons',
    description: 'Shared icon resolver/registry must have regression coverage.',
    required: true,
    evidencePatterns: [/iconRegistry\.test\.[jt]sx?$/, /iconResolver.*test\.[jt]sx?$/],
  },
  {
    id: 'gis-layer-runtime',
    area: 'gis',
    description: 'Layer runtime/factory lifecycle must be covered.',
    required: true,
    evidencePatterns: [/layerRuntime\.test\.[jt]sx?$/, /layerFactory\.test\.[jt]sx?$/],
  },
  {
    id: 'gis-layer-ownership',
    area: 'gis',
    description: 'Cross-tool layer/graphics ownership must be covered.',
    required: true,
    evidencePatterns: [/layerOwnership\.test\.[jt]sx?$/],
  },
  {
    id: 'gis-scene-runtime',
    area: 'gis',
    description: '3D scene lifecycle/parity must be covered.',
    required: true,
    evidencePatterns: [/sceneRuntime\.test\.[jt]sx?$/],
  },
  {
    id: 'gis-identify-runtime',
    area: 'gis',
    description: 'Identify cancellation/dedupe/runtime behavior must be covered.',
    required: true,
    evidencePatterns: [/identifyRuntime\.test\.[jt]sx?$/],
  },
  {
    id: 'gis-measurement-runtime',
    area: 'gis',
    description: 'Measurement lifecycle must be covered.',
    required: true,
    evidencePatterns: [/measurementRuntime\.test\.[jt]sx?$/],
  },
  {
    id: 'query-runtime',
    area: 'search',
    description: 'Query pagination, cancellation and normalization must be covered.',
    required: true,
    evidencePatterns: [/GisQueryHelper\.test\.[jt]sx?$/, /QuerySearchRuntime\.test\.[jt]sx?$/, /SearchExecutionRuntime\.test\.[jt]sx?$/],
  },
  {
    id: 'data-integrity',
    area: 'data',
    description: 'Schema drift, malformed data and normalization must be covered.',
    required: true,
    evidencePatterns: [/DataIntegrityHelper\.test\.[jt]sx?$/, /RecordSchemaRuntime\.test\.[jt]sx?$/],
  },
  {
    id: 'address-search',
    area: 'search',
    description: 'Address hierarchy/search/spatial edge cases must be covered.',
    required: true,
    evidencePatterns: [/AddressSearchRuntime\.test\.[jt]sx?$/],
  },
  {
    id: 'platform-bootstrap',
    area: 'architecture',
    description: 'Platform bootstrap URL/config/failure semantics must be covered.',
    required: true,
    evidencePatterns: [/bootstrap.*\.test\.[jt]sx?$/],
  },
  {
    id: 'platform-http',
    area: 'network',
    description: 'Shared HTTP transport retry/cancellation/error behavior must be covered.',
    required: true,
    evidencePatterns: [/(?:apiClient|http|transport).*\.test\.[jt]sx?$/i, /platform\.test\.[jt]sx?$/],
  },
  {
    id: 'experience-interaction',
    area: 'accessibility',
    description: 'Shared interaction/focus/external-navigation behavior must be covered.',
    required: true,
    evidencePatterns: [/QueryInteractionRuntime\.test\.[jt]sx?$/, /ExperienceUXLayer\.test\.[jt]sx?$/],
  },
  {
    id: 'experience-managed-window',
    area: 'accessibility',
    description: 'Managed query window lifecycle must be covered.',
    required: true,
    evidencePatterns: [/ManagedFastAccessQueryWindow\.test\.[jt]sx?$/, /LazyManagedWindow.*test\.[jt]sx?$/],
  },
  {
    id: 'configuration-business',
    area: 'network',
    description: 'Configuration transport/response contract must be covered.',
    required: true,
    evidencePatterns: [/ConfigurationBusiness\.test\.[jt]sx?$/],
  },
  {
    id: 'logging-redaction',
    area: 'observability',
    description: 'Logging/telemetry redaction behavior must be covered.',
    required: true,
    evidencePatterns: [/LoggingBusiness\.test\.[jt]sx?$/, /telemetry.*test\.[jt]sx?$/i],
  },
  {
    id: 'backend-resilience',
    area: 'architecture',
    description: 'Backend resilience/rate limiting/diagnostics must have automated tests.',
    required: true,
    evidencePatterns: [/Resilience.*Tests?\.cs$/i, /RateLimit.*Tests?\.cs$/i, /Diagnostics.*Tests?\.cs$/i],
  },
]);

function contractSatisfied(inventory: RepositoryInventory, contract: TestContract): boolean {
  return inventory.files.some(file => contract.evidencePatterns.some(pattern => pattern.test(file.repositoryPath)));
}

export function auditTestContracts(
  inventory: RepositoryInventory,
  contracts: readonly TestContract[] = RELEASE_TEST_CONTRACTS,
): AuditSection<TestCoverageSummary> {
  const start = performance.now();
  const satisfied: string[] = [];
  const missing: string[] = [];
  const findings: Finding[] = [];

  for (const contract of contracts) {
    if (contractSatisfied(inventory, contract)) {
      satisfied.push(contract.id);
      continue;
    }
    missing.push(contract.id);
    findings.push({
      id: `test-contract-missing-${contract.id}`,
      domain: 'testing',
      severity: contract.required ? 'high' : 'medium',
      title: 'Required regression contract not detected',
      message: `${contract.id}: ${contract.description}`,
      evidence: { value: contract.area },
      remediation: 'Add a focused regression test around the real runtime contract; avoid duplicate boilerplate tests.',
      ...(contract.required ? { tags: ['required'] } : {}),
    });
  }

  const sorted = stableSortFindings(findings);
  return {
    domain: 'testing',
    title: 'Release regression contract coverage',
    summary: {
      contracts,
      satisfied: satisfied.sort(),
      missing: missing.sort(),
      findings: sorted,
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
