import {
  auditLegacyPresentationCss,
  type LegacyPresentationFinding,
  type LegacyPresentationRisk,
} from './legacyPresentationPolicy';

export type LegacyRemediationStatus = 'remediated' | 'unresolved';

export interface LegacyPresentationRemediationEvidence {
  readonly risk: LegacyPresentationRisk;
  readonly status: LegacyRemediationStatus;
  readonly findingCount: number;
  readonly evidence: readonly string[];
  readonly missing: readonly string[];
}

export interface LegacyPresentationRemediationReport {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly remediatedFindingCount: number;
  readonly unresolvedFindingCount: number;
  readonly coveragePercent: number;
  readonly risks: Readonly<Record<LegacyPresentationRisk, LegacyPresentationRemediationEvidence>>;
}

export interface LegacyPresentationRemediationInput {
  readonly legacyCss: string;
  readonly effectiveLegacyCss: string;
  readonly foundationCss: string;
  readonly modernizationCss: string;
}

interface RemediationRule {
  readonly risk: LegacyPresentationRisk;
  readonly requiredFoundation?: readonly RegExp[];
  readonly requiredModernization?: readonly RegExp[];
  readonly effectiveLegacyMustNotMatch?: readonly RegExp[];
  readonly description: readonly string[];
}

const MAX_SOURCE_LENGTH = 750_000;
const MAX_EVIDENCE_LENGTH = 180;

const RULES: readonly RemediationRule[] = Object.freeze([
  Object.freeze({
    risk: 'remote-font',
    requiredFoundation: Object.freeze([
      /--legacy-font-sans\s*:/i,
      /font-family\s*:\s*var\(--legacy-font-sans\)/i,
    ]),
    effectiveLegacyMustNotMatch: Object.freeze([
      /@import\s+(?:url\()?['"]?https?:\/\//i,
      /fonts\.(?:googleapis|gstatic)\.com/i,
    ]),
    description: Object.freeze([
      'effective legacy CSS contains no remote stylesheet import',
      'local/system font stack is present in the governed foundation',
    ]),
  }),
  Object.freeze({
    risk: 'focus-suppression',
    requiredModernization: Object.freeze([
      /:focus-visible\s*\{[^}]*outline\s*:\s*var\(--legacy-focus-ring\)\s*!important/is,
      /outline-offset\s*:\s*var\(--legacy-focus-offset\)\s*!important/i,
      /\.btn:focus-visible\s*\{[^}]*outline\s*:\s*var\(--legacy-focus-ring\)\s*!important/is,
    ]),
    description: Object.freeze([
      'global focus-visible recovery is explicit and important enough to beat legacy suppression',
      'legacy .btn focus suppression is overridden with a visible ring',
    ]),
  }),
  Object.freeze({
    risk: 'hover-only-disclosure',
    requiredModernization: Object.freeze([
      /\.dropdown:focus-within\s+\.dropdown-content\s*\{[^}]*display\s*:\s*block/is,
      /\.dropdown-content\s+a:focus-visible/i,
    ]),
    description: Object.freeze([
      'dropdown disclosure has a keyboard focus-within equivalent',
      'dropdown items expose a visible keyboard state',
    ]),
  }),
  Object.freeze({
    risk: 'undersized-target',
    requiredModernization: Object.freeze([
      /--legacy-target-min\s*:\s*44px/i,
      /--legacy-target-coarse\s*:\s*48px/i,
      /#locateButtonContainer[^}]*min-inline-size\s*:\s*var\(--legacy-target-min\)/is,
      /@media\s*\(pointer:\s*coarse\)/i,
    ]),
    requiredFoundation: Object.freeze([
      /--legacy-control-height\s*:\s*44px/i,
      /--legacy-control-height-coarse\s*:\s*48px/i,
    ]),
    description: Object.freeze([
      'default interactive target budget is at least 44px',
      'coarse-pointer target budget is at least 48px',
      'legacy locate control is explicitly brought into the target budget',
    ]),
  }),
  Object.freeze({
    risk: 'fixed-panel-width',
    requiredModernization: Object.freeze([
      /\.common-query-window\s*\{[^}]*inline-size\s*:\s*min\(/is,
      /max-inline-size\s*:\s*var\(--legacy-panel-max\)/i,
      /\.ZoningStatusDocument_ModalContainer\s+\.modal-dialog\s*\{[^}]*inline-size\s*:\s*min\(/is,
      /@media\s*\(max-width:\s*767\.98px\)/i,
    ]),
    description: Object.freeze([
      'query windows use viewport-bounded logical inline sizing',
      'legacy zoning modal is viewport bounded',
      'compact breakpoint removes desktop-only fixed sizing',
    ]),
  }),
  Object.freeze({
    risk: 'physical-positioning',
    requiredModernization: Object.freeze([
      /inset-inline-start\s*:/i,
      /inset-inline-end\s*:/i,
      /inset-block-start\s*:/i,
      /inset-block-end\s*:/i,
    ]),
    description: Object.freeze([
      'direction-neutral inline positioning is present',
      'block-axis positioning is expressed with logical properties',
    ]),
  }),
]);

const boundedSource = (source: string): string => source.slice(0, MAX_SOURCE_LENGTH);

const boundedEvidence = (value: string): string => value
  .trim()
  .replace(/\s+/g, ' ')
  .slice(0, MAX_EVIDENCE_LENGTH);

const matchesAll = (
  source: string,
  patterns: readonly RegExp[] | undefined,
): readonly { ok: boolean; evidence: string[]; missing: string[] }[] => {
  if (!patterns) return [];
  return patterns.map((pattern) => {
    const match = source.match(pattern);
    return {
      ok: Boolean(match),
      evidence: match?.[0] ? [boundedEvidence(match[0])] : [],
      missing: match ? [] : [pattern.source],
    };
  });
};

const matchesNone = (
  source: string,
  patterns: readonly RegExp[] | undefined,
): readonly { ok: boolean; evidence: string[]; missing: string[] }[] => {
  if (!patterns) return [];
  return patterns.map((pattern) => {
    const match = source.match(pattern);
    return {
      ok: !match,
      evidence: match ? [] : [`absent:${pattern.source}`],
      missing: match?.[0] ? [`forbidden:${boundedEvidence(match[0])}`] : [],
    };
  });
};

const findingCountFor = (
  findings: readonly LegacyPresentationFinding[],
  risk: LegacyPresentationRisk,
): number => findings.reduce((count, finding) => count + (finding.risk === risk ? 1 : 0), 0);

const evidenceForRule = (
  rule: RemediationRule,
  sources: Readonly<{
    effectiveLegacyCss: string;
    foundationCss: string;
    modernizationCss: string;
  }>,
): LegacyPresentationRemediationEvidence => {
  const checks = [
    ...matchesAll(sources.foundationCss, rule.requiredFoundation),
    ...matchesAll(sources.modernizationCss, rule.requiredModernization),
    ...matchesNone(sources.effectiveLegacyCss, rule.effectiveLegacyMustNotMatch),
  ];
  const evidence = checks.flatMap((check) => check.evidence);
  const missing = checks.flatMap((check) => check.missing);

  return Object.freeze({
    risk: rule.risk,
    status: missing.length === 0 ? 'remediated' : 'unresolved',
    findingCount: 0,
    evidence: Object.freeze(evidence),
    missing: Object.freeze(missing),
  });
};

export const evaluateLegacyPresentationRemediation = (
  input: LegacyPresentationRemediationInput,
): LegacyPresentationRemediationReport => {
  const legacyCss = boundedSource(input.legacyCss);
  const sources = Object.freeze({
    effectiveLegacyCss: boundedSource(input.effectiveLegacyCss),
    foundationCss: boundedSource(input.foundationCss),
    modernizationCss: boundedSource(input.modernizationCss),
  });
  const audit = auditLegacyPresentationCss(legacyCss);

  const riskEntries = RULES.map((rule) => {
    const evidence = evidenceForRule(rule, sources);
    const findingCount = findingCountFor(audit.findings, rule.risk);
    return [rule.risk, Object.freeze({ ...evidence, findingCount })] as const;
  });
  const risks = Object.freeze(Object.fromEntries(riskEntries)) as Readonly<
    Record<LegacyPresentationRisk, LegacyPresentationRemediationEvidence>
  >;

  const unresolvedFindingCount = RULES.reduce((count, rule) => {
    const entry = risks[rule.risk];
    return count + (entry.status === 'unresolved' ? entry.findingCount : 0);
  }, 0);
  const findingCount = audit.findings.length;
  const remediatedFindingCount = Math.max(0, findingCount - unresolvedFindingCount);
  const coveragePercent = findingCount === 0
    ? 100
    : Math.round((remediatedFindingCount / findingCount) * 100);

  return Object.freeze({
    passed: unresolvedFindingCount === 0 && RULES.every((rule) => risks[rule.risk].status === 'remediated'),
    findingCount,
    remediatedFindingCount,
    unresolvedFindingCount,
    coveragePercent,
    risks,
  });
};

export const legacyPresentationRemediationChecklist = (): readonly string[] => Object.freeze(
  RULES.flatMap((rule) => rule.description.map((description) => `${rule.risk}: ${description}`)),
);
