import {
  GENERAL_SEARCH_WINDOW_VERSION_V10,
  type GeneralSearchNormalizedPolicyV10,
  type GeneralSearchWindowSnapshotV10,
} from './GenelAramaWindowContractsV10';
import { generalSearchPresentationFingerprintV10 } from './GenelAramaWindowPresentationV10';

export type GeneralSearchAuditSeverityV10 = 'warning' | 'error';

export type GeneralSearchAuditCodeV10 =
  | 'version-mismatch'
  | 'negative-count'
  | 'matched-count-exceeds-total'
  | 'items-count-mismatch'
  | 'duplicate-identity'
  | 'active-index-out-of-range'
  | 'active-identity-mismatch'
  | 'active-result-not-visible'
  | 'visible-window-budget-exceeded'
  | 'visible-window-count-mismatch'
  | 'render-window-range-invalid'
  | 'facet-selection-budget-exceeded'
  | 'facet-selection-not-reflected'
  | 'announcement-empty'
  | 'guidance-empty'
  | 'record-limit-warning-missing';

export interface GeneralSearchAuditFindingV10 {
  readonly code: GeneralSearchAuditCodeV10;
  readonly severity: GeneralSearchAuditSeverityV10;
  readonly detail: string;
}

export interface GeneralSearchAuditResultV10 {
  readonly valid: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly findings: readonly GeneralSearchAuditFindingV10[];
  readonly fingerprint: string;
}

const finding = (
  code: GeneralSearchAuditCodeV10,
  severity: GeneralSearchAuditSeverityV10,
  detail: string,
): GeneralSearchAuditFindingV10 => Object.freeze({ code, severity, detail });

const duplicateIdentities = (
  snapshot: GeneralSearchWindowSnapshotV10,
): readonly string[] => {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const item of snapshot.items) {
    if (seen.has(item.identity)) duplicate.add(item.identity);
    else seen.add(item.identity);
  }
  return Object.freeze([...duplicate].sort((left, right) => left.localeCompare(right, 'en')));
};

const selectedFacetValues = (
  snapshot: GeneralSearchWindowSnapshotV10,
): ReadonlySet<string> => new Set([
  ...snapshot.selectedCategories,
  ...snapshot.selectedTypes,
]);

const reflectedSelectedFacets = (
  snapshot: GeneralSearchWindowSnapshotV10,
): ReadonlySet<string> => {
  const reflected = new Set<string>();
  for (const facet of snapshot.facets) {
    for (const bucket of facet.buckets) {
      if (bucket.selected) reflected.add(bucket.normalizedValue);
    }
  }
  return reflected;
};

export const auditGeneralSearchWindowSnapshotV10 = (
  snapshot: GeneralSearchWindowSnapshotV10,
  policy: GeneralSearchNormalizedPolicyV10,
): GeneralSearchAuditResultV10 => {
  const findings: GeneralSearchAuditFindingV10[] = [];

  if (snapshot.version !== GENERAL_SEARCH_WINDOW_VERSION_V10) {
    findings.push(finding(
      'version-mismatch',
      'error',
      `Expected ${GENERAL_SEARCH_WINDOW_VERSION_V10}, received ${String(snapshot.version)}.`,
    ));
  }

  if (snapshot.totalCount < 0 || snapshot.matchedCount < 0) {
    findings.push(finding(
      'negative-count',
      'error',
      `Counts must be non-negative: total=${snapshot.totalCount}, matched=${snapshot.matchedCount}.`,
    ));
  }

  if (snapshot.matchedCount > snapshot.totalCount) {
    findings.push(finding(
      'matched-count-exceeds-total',
      'error',
      `Matched count ${snapshot.matchedCount} exceeds total count ${snapshot.totalCount}.`,
    ));
  }

  if (snapshot.items.length !== snapshot.matchedCount) {
    findings.push(finding(
      'items-count-mismatch',
      'error',
      `Item count ${snapshot.items.length} differs from matched count ${snapshot.matchedCount}.`,
    ));
  }

  const duplicates = duplicateIdentities(snapshot);
  if (duplicates.length > 0) {
    findings.push(finding(
      'duplicate-identity',
      'error',
      `Duplicate UI identities detected: ${duplicates.slice(0, 5).join(', ')}.`,
    ));
  }

  if (snapshot.matchedCount === 0) {
    if (snapshot.activeIndex !== -1 || snapshot.activeIdentity !== null || snapshot.activeRecord !== null) {
      findings.push(finding(
        'active-index-out-of-range',
        'error',
        'Empty result collections must not expose an active result.',
      ));
    }
  } else if (snapshot.activeIndex < 0 || snapshot.activeIndex >= snapshot.matchedCount) {
    findings.push(finding(
      'active-index-out-of-range',
      'error',
      `Active index ${snapshot.activeIndex} is outside 0-${snapshot.matchedCount - 1}.`,
    ));
  }

  if (snapshot.activeIndex >= 0) {
    const activeItem = snapshot.items[snapshot.activeIndex] ?? null;
    if (!activeItem || activeItem.identity !== snapshot.activeIdentity) {
      findings.push(finding(
        'active-identity-mismatch',
        'error',
        'Active identity does not match the item at activeIndex.',
      ));
    }
    if (!snapshot.visibleItems.some(item => item.identity === snapshot.activeIdentity)) {
      findings.push(finding(
        'active-result-not-visible',
        'error',
        'The keyboard-active result is outside the bounded visible result window.',
      ));
    }
  }

  if (snapshot.visibleItems.length > policy.renderWindowSize) {
    findings.push(finding(
      'visible-window-budget-exceeded',
      'error',
      `Visible item count ${snapshot.visibleItems.length} exceeds render budget ${policy.renderWindowSize}.`,
    ));
  }

  if (snapshot.visibleItems.length !== snapshot.renderWindow.count) {
    findings.push(finding(
      'visible-window-count-mismatch',
      'error',
      `Visible item count ${snapshot.visibleItems.length} differs from render window count ${snapshot.renderWindow.count}.`,
    ));
  }

  const renderWindow = snapshot.renderWindow;
  const invalidRange = renderWindow.startIndex < 0
    || renderWindow.endIndexExclusive < renderWindow.startIndex
    || renderWindow.endIndexExclusive > snapshot.matchedCount
    || renderWindow.totalMatched !== snapshot.matchedCount;
  if (invalidRange) {
    findings.push(finding(
      'render-window-range-invalid',
      'error',
      `Invalid render window ${renderWindow.startIndex}-${renderWindow.endIndexExclusive} for ${snapshot.matchedCount} matches.`,
    ));
  }

  const selectedCount = snapshot.selectedCategories.length + snapshot.selectedTypes.length;
  if (selectedCount > policy.maxSelectedFacets) {
    findings.push(finding(
      'facet-selection-budget-exceeded',
      'error',
      `Selected facet count ${selectedCount} exceeds budget ${policy.maxSelectedFacets}.`,
    ));
  }

  const expectedSelection = selectedFacetValues(snapshot);
  const reflectedSelection = reflectedSelectedFacets(snapshot);
  const missingReflections = [...expectedSelection].filter(value => !reflectedSelection.has(value));
  if (missingReflections.length > 0) {
    findings.push(finding(
      'facet-selection-not-reflected',
      'warning',
      `Selected facets are outside visible facet buckets: ${missingReflections.slice(0, 5).join(', ')}.`,
    ));
  }

  if (!snapshot.announcement.trim()) {
    findings.push(finding(
      'announcement-empty',
      'error',
      'Search window snapshot must expose a non-empty assistive announcement.',
    ));
  }

  if (!snapshot.guidance.title.trim() || !snapshot.guidance.detail.trim()) {
    findings.push(finding(
      'guidance-empty',
      'error',
      'Search window guidance requires both title and detail text.',
    ));
  }

  if (snapshot.resultLimitReached && snapshot.guidance.tone !== 'warning') {
    findings.push(finding(
      'record-limit-warning-missing',
      'warning',
      'A truncated source collection should expose warning guidance.',
    ));
  }

  const errors = findings.filter(item => item.severity === 'error').length;
  const warnings = findings.length - errors;
  const fingerprint = generalSearchPresentationFingerprintV10({
    version: GENERAL_SEARCH_WINDOW_VERSION_V10,
    snapshotFingerprint: snapshot.fingerprint,
    findings: findings.map(item => [item.code, item.severity, item.detail]),
  });
  return Object.freeze({
    valid: errors === 0,
    errors,
    warnings,
    findings: Object.freeze(findings),
    fingerprint,
  });
};

export const assertGeneralSearchWindowSnapshotV10 = (
  snapshot: GeneralSearchWindowSnapshotV10,
  policy: GeneralSearchNormalizedPolicyV10,
): GeneralSearchWindowSnapshotV10 => {
  const audit = auditGeneralSearchWindowSnapshotV10(snapshot, policy);
  if (!audit.valid) {
    const details = audit.findings
      .filter(item => item.severity === 'error')
      .map(item => item.code)
      .join(', ');
    throw new Error(`General search window integrity failed: ${details}`);
  }
  return snapshot;
};
