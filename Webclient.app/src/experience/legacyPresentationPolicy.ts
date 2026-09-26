export type LegacyPresentationRisk =
  | 'remote-font'
  | 'focus-suppression'
  | 'hover-only-disclosure'
  | 'undersized-target'
  | 'fixed-panel-width'
  | 'physical-positioning';

export interface LegacyPresentationFinding {
  readonly risk: LegacyPresentationRisk;
  readonly selector: string;
  readonly evidence: string;
  readonly remediation: string;
  readonly severity: 'high' | 'medium' | 'low';
}

export interface LegacyPresentationAudit {
  readonly findings: readonly LegacyPresentationFinding[];
  readonly counts: Readonly<Record<LegacyPresentationRisk, number>>;
  readonly passed: boolean;
}

const risks: readonly LegacyPresentationRisk[] = [
  'remote-font',
  'focus-suppression',
  'hover-only-disclosure',
  'undersized-target',
  'fixed-panel-width',
  'physical-positioning',
];

const emptyCounts = (): Record<LegacyPresentationRisk, number> => ({
  'remote-font': 0,
  'focus-suppression': 0,
  'hover-only-disclosure': 0,
  'undersized-target': 0,
  'fixed-panel-width': 0,
  'physical-positioning': 0,
});

const boundedEvidence = (value: string): string => value.trim().replace(/\s+/g, ' ').slice(0, 180);

const add = (
  findings: LegacyPresentationFinding[],
  counts: Record<LegacyPresentationRisk, number>,
  finding: LegacyPresentationFinding,
): void => {
  if (findings.length >= 128) return;
  findings.push(finding);
  counts[finding.risk] += 1;
};

const blocks = (css: string): readonly { selector: string; body: string }[] => {
  const result: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null && result.length < 512) {
    const selector = boundedEvidence(match[1] ?? '');
    const body = match[2] ?? '';
    if (selector && body) result.push({ selector, body });
  }
  return result;
};

export const auditLegacyPresentationCss = (css: string): LegacyPresentationAudit => {
  const findings: LegacyPresentationFinding[] = [];
  const counts = emptyCounts();
  const source = css.slice(0, 500_000);

  for (const importMatch of source.matchAll(/@import\s+(?:url\()?['"]?([^'"\s)]+)[^;]*;/gi)) {
    const target = importMatch[1] ?? '';
    if (/^https?:\/\//i.test(target)) {
      add(findings, counts, {
        risk: 'remote-font',
        selector: '@import',
        evidence: boundedEvidence(importMatch[0]),
        remediation: 'Remove the remote stylesheet and use the governed local/system typography stack.',
        severity: 'high',
      });
    }
  }

  for (const block of blocks(source)) {
    const body = block.body;
    const selector = block.selector;
    if (/:focus(?:-visible)?\b/i.test(selector) && /outline\s*:\s*(?:0|none)\b/i.test(body) && /box-shadow\s*:\s*none\b/i.test(body)) {
      add(findings, counts, {
        risk: 'focus-suppression',
        selector,
        evidence: boundedEvidence(body),
        remediation: 'Preserve a visible focus-visible outline or equivalent high-contrast focus indicator.',
        severity: 'high',
      });
    }
    if (/:hover\b/i.test(selector) && /display\s*:\s*(?:block|flex|grid)\b/i.test(body)) {
      add(findings, counts, {
        risk: 'hover-only-disclosure',
        selector,
        evidence: boundedEvidence(body),
        remediation: 'Pair hover disclosure with keyboard/focus or explicit button state.',
        severity: 'high',
      });
    }
    const dimensions = [...body.matchAll(/(?:width|height)\s*:\s*(\d+(?:\.\d+)?)px/gi)];
    if (dimensions.some((entry) => Number(entry[1]) > 0 && Number(entry[1]) < 40) && /(button|btn|tool|control|item|locate)/i.test(selector)) {
      add(findings, counts, {
        risk: 'undersized-target',
        selector,
        evidence: boundedEvidence(body),
        remediation: 'Use at least a 44px effective pointer target, or 48px for primary coarse-pointer controls.',
        severity: 'medium',
      });
    }
    if (/(?:min-width|width)\s*:\s*[4-9]\d{2}px/i.test(body) && /(window|modal|panel|results|menu)/i.test(selector)) {
      add(findings, counts, {
        risk: 'fixed-panel-width',
        selector,
        evidence: boundedEvidence(body),
        remediation: 'Bound panel inline-size with min(), max-inline-size and viewport-safe responsive rules.',
        severity: 'medium',
      });
    }
    if (/(?:left|right)\s*:/i.test(body) && /(panel|window|menu|drawer|sidebar|toolbar)/i.test(selector)) {
      add(findings, counts, {
        risk: 'physical-positioning',
        selector,
        evidence: boundedEvidence(body),
        remediation: 'Prefer logical inset-inline properties where direction-neutral positioning is possible.',
        severity: 'low',
      });
    }
  }

  return {
    findings,
    counts,
    passed: risks.every((risk) => counts[risk] === 0),
  };
};
