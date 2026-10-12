import type { LayerListGroupInput } from './layerListExperienceModel';

export type LayerListCatalogFindingCode =
  | 'duplicate-group-id'
  | 'duplicate-layer-id'
  | 'empty-group-title'
  | 'empty-layer-title'
  | 'invalid-opacity'
  | 'group-budget-exceeded'
  | 'layer-budget-exceeded';

export interface LayerListCatalogFinding {
  readonly code: LayerListCatalogFindingCode;
  readonly groupId: string | null;
  readonly layerId: string | null;
  readonly severity: 'warning' | 'error';
}

export interface LayerListCatalogAuditResult {
  readonly valid: boolean;
  readonly findingCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly findings: readonly LayerListCatalogFinding[];
}

export interface LayerListCatalogAuditOptions {
  readonly maxGroups?: number;
  readonly maxLayers?: number;
}

const DEFAULT_MAX_GROUPS = 64;
const DEFAULT_MAX_LAYERS = 512;

const clampBudget = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.min(2048, Math.trunc(value ?? fallback))) : fallback;

const finding = (
  code: LayerListCatalogFindingCode,
  severity: LayerListCatalogFinding['severity'],
  groupId: string | null,
  layerId: string | null,
): LayerListCatalogFinding => Object.freeze({ code, severity, groupId, layerId });

export const auditLayerListCatalog = (
  groups: readonly LayerListGroupInput[],
  options: LayerListCatalogAuditOptions = {},
): LayerListCatalogAuditResult => {
  const maxGroups = clampBudget(options.maxGroups, DEFAULT_MAX_GROUPS);
  const maxLayers = clampBudget(options.maxLayers, DEFAULT_MAX_LAYERS);
  const findings: LayerListCatalogFinding[] = [];
  const groupIds = new Set<string>();
  const layerKeys = new Set<string>();
  let layerCount = 0;

  if (groups.length > maxGroups) {
    findings.push(finding('group-budget-exceeded', 'error', null, null));
  }

  for (const group of groups) {
    const groupId = group.id.trim();

    if (groupIds.has(groupId)) {
      findings.push(finding('duplicate-group-id', 'error', groupId || null, null));
    } else {
      groupIds.add(groupId);
    }

    if (!group.title.trim()) {
      findings.push(finding('empty-group-title', 'warning', groupId || null, null));
    }

    for (const layer of group.layers) {
      layerCount += 1;
      const layerId = layer.id.trim();
      const key = `${groupId}::${layerId}`;

      if (layerKeys.has(key)) {
        findings.push(finding('duplicate-layer-id', 'error', groupId || null, layerId || null));
      } else {
        layerKeys.add(key);
      }

      if (!layer.title.trim()) {
        findings.push(finding('empty-layer-title', 'warning', groupId || null, layerId || null));
      }

      if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 100) {
        findings.push(finding('invalid-opacity', 'warning', groupId || null, layerId || null));
      }
    }
  }

  if (layerCount > maxLayers) {
    findings.push(finding('layer-budget-exceeded', 'error', null, null));
  }

  const errorCount = findings.filter((item) => item.severity === 'error').length;
  const warningCount = findings.length - errorCount;

  return Object.freeze({
    valid: errorCount === 0,
    findingCount: findings.length,
    errorCount,
    warningCount,
    findings: Object.freeze(findings),
  });
};

export const summarizeLayerListCatalogAudit = (result: LayerListCatalogAuditResult): Readonly<{
  valid: boolean;
  findingCount: number;
  errorCount: number;
  warningCount: number;
  codes: readonly LayerListCatalogFindingCode[];
}> => Object.freeze({
  valid: result.valid,
  findingCount: result.findingCount,
  errorCount: result.errorCount,
  warningCount: result.warningCount,
  codes: Object.freeze(result.findings.map((item) => item.code)),
});
