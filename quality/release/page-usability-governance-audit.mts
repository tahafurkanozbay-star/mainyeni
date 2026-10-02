import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface PageUsabilitySignal {
  readonly file: string;
  readonly clickHandlers: number;
  readonly clickableNonInteractive: number;
  readonly imageElements: number;
  readonly imagesWithoutAlt: number;
  readonly blankTargets: number;
  readonly blankTargetsWithoutRel: number;
  readonly outlineSuppressions: number;
  readonly largeFixedWidths: number;
  readonly globalOverflowHidden: number;
  readonly reducedMotionContracts: number;
  readonly forcedColorContracts: number;
  readonly focusVisibleContracts: number;
}

export interface PageUsabilityGovernanceSummary {
  readonly files: readonly PageUsabilitySignal[];
  readonly componentFiles: number;
  readonly styleFiles: number;
  readonly interactionFiles: number;
  readonly responsiveRiskFiles: number;
  readonly accessibilityRiskFiles: number;
  readonly findings: readonly Finding[];
}

const WEB_SOURCE = /^Webclient\.app\/src\//;
const COMPONENT = /\.(?:tsx|jsx)$/i;
const STYLE = /\.css$/i;
const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|generated|qa-artifacts)(?:\/|$)/i;
const TEST_FILE = /(?:\.test|\.spec)\.(?:tsx|jsx)$/i;
const NATIVE_INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'option']);
const CLICK_TAG = /<([A-Za-z][A-Za-z0-9.-]*)\b([^>]*\bonClick\s*=\s*\{[^}]*\}[^>]*)>/g;
const IMAGE_TAG = /<img\b([^>]*)>/gi;
const ANCHOR_BLANK = /<a\b([^>]*\btarget\s*=\s*(?:['"]_blank['"]|\{['"]_blank['"]\})[^>]*)>/gi;
const OUTLINE_SUPPRESSION = /\boutline\s*:\s*(?:none|0(?:px)?)\s*(?:!important)?\s*;/gi;
const FIXED_WIDTH = /\b(?:width|min-width)\s*:\s*(\d+(?:\.\d+)?)px\s*(?:!important)?\s*;/gi;
const GLOBAL_OVERFLOW = /(?:^|[},\s])(?:html|body|#root)\s*(?:,\s*(?:html|body|#root)\s*)*\{[^}]*\boverflow-x?\s*:\s*hidden\b/gi;
const REDUCED_MOTION = /@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/gi;
const FORCED_COLORS = /@media\s*\([^)]*forced-colors\s*:\s*active[^)]*\)/gi;
const FOCUS_VISIBLE = /:focus-visible\b/gi;
const MAX_FINDINGS = 24;

function count(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags);
  let total = 0;
  while (matcher.exec(text) !== null) total += 1;
  return total;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function excerpt(text: string, offset: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  const next = text.indexOf('\n', offset);
  const end = next < 0 ? text.length : next;
  const value = text.slice(start, end).trim().replace(/\s+/g, ' ');
  return value.length <= 180 ? value : `${value.slice(0, 179)}…`;
}

function componentFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WEB_SOURCE.test(file.repositoryPath)
    && COMPONENT.test(file.repositoryPath)
    && !GENERATED.test(file.repositoryPath)
    && !TEST_FILE.test(file.repositoryPath));
}

function styleFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WEB_SOURCE.test(file.repositoryPath)
    && STYLE.test(file.repositoryPath)
    && !GENERATED.test(file.repositoryPath));
}

function hasKeyboardContract(attributes: string): boolean {
  return /\bonKey(?:Down|Up|Press)\s*=/.test(attributes)
    || /\btabIndex\s*=/.test(attributes)
    || /\brole\s*=\s*(?:['"](?:button|link|menuitem|option|tab|checkbox|switch|radio)['"]|\{['"](?:button|link|menuitem|option|tab|checkbox|switch|radio)['"]\})/.test(attributes);
}

function clickableNonInteractive(file: SourceFile): number {
  let total = 0;
  const matcher = new RegExp(CLICK_TAG.source, CLICK_TAG.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    const tag = (match[1] ?? '').toLowerCase();
    const attributes = match[2] ?? '';
    if (NATIVE_INTERACTIVE.has(tag)) continue;
    if (/^[A-Z]/.test(match[1] ?? '')) continue;
    if (!hasKeyboardContract(attributes)) total += 1;
  }
  return total;
}

function imagesWithoutAlt(file: SourceFile): number {
  let total = 0;
  const matcher = new RegExp(IMAGE_TAG.source, IMAGE_TAG.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    const attributes = match[1] ?? '';
    if (!/\balt\s*=/.test(attributes)) total += 1;
  }
  return total;
}

function blankTargetStats(file: SourceFile): { total: number; unsafe: number } {
  let total = 0;
  let unsafe = 0;
  const matcher = new RegExp(ANCHOR_BLANK.source, ANCHOR_BLANK.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    total += 1;
    const attributes = match[1] ?? '';
    const rel = attributes.match(/\brel\s*=\s*(?:['"]([^'"]*)['"]|\{['"]([^'"]*)['"]\})/i);
    const value = `${rel?.[1] ?? ''} ${rel?.[2] ?? ''}`.toLowerCase();
    if (!/\bnoopener\b/.test(value)) unsafe += 1;
  }
  return { total, unsafe };
}

function fixedWidths(file: SourceFile): number {
  let total = 0;
  const matcher = new RegExp(FIXED_WIDTH.source, FIXED_WIDTH.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    const value = Number.parseFloat(match[1] ?? '0');
    if (Number.isFinite(value) && value >= 720) total += 1;
  }
  return total;
}

function componentSignal(file: SourceFile): PageUsabilitySignal {
  const blank = blankTargetStats(file);
  return {
    file: file.repositoryPath,
    clickHandlers: count(file.text, /\bonClick\s*=/g),
    clickableNonInteractive: clickableNonInteractive(file),
    imageElements: count(file.text, IMAGE_TAG),
    imagesWithoutAlt: imagesWithoutAlt(file),
    blankTargets: blank.total,
    blankTargetsWithoutRel: blank.unsafe,
    outlineSuppressions: 0,
    largeFixedWidths: 0,
    globalOverflowHidden: 0,
    reducedMotionContracts: 0,
    forcedColorContracts: 0,
    focusVisibleContracts: 0,
  };
}

function styleSignal(file: SourceFile): PageUsabilitySignal {
  return {
    file: file.repositoryPath,
    clickHandlers: 0,
    clickableNonInteractive: 0,
    imageElements: 0,
    imagesWithoutAlt: 0,
    blankTargets: 0,
    blankTargetsWithoutRel: 0,
    outlineSuppressions: count(file.text, OUTLINE_SUPPRESSION),
    largeFixedWidths: fixedWidths(file),
    globalOverflowHidden: count(file.text, GLOBAL_OVERFLOW),
    reducedMotionContracts: count(file.text, REDUCED_MOTION),
    forcedColorContracts: count(file.text, FORCED_COLORS),
    focusVisibleContracts: count(file.text, FOCUS_VISIBLE),
  };
}

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  file: SourceFile,
  offset: number,
  remediation: string,
  tags: readonly string[],
): Finding {
  return {
    id,
    domain: tags.includes('responsive') ? 'responsive' : 'accessibility',
    severity,
    title,
    message,
    location: { file: file.repositoryPath, line: lineAt(file.text, offset) },
    evidence: { excerpt: excerpt(file.text, offset) },
    remediation,
    tags,
  };
}

function componentFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const clickMatcher = new RegExp(CLICK_TAG.source, CLICK_TAG.flags);
  let click: RegExpExecArray | null;
  while ((click = clickMatcher.exec(file.text)) !== null) {
    const tag = (click[1] ?? '').toLowerCase();
    const attributes = click[2] ?? '';
    if (NATIVE_INTERACTIVE.has(tag) || /^[A-Z]/.test(click[1] ?? '') || hasKeyboardContract(attributes)) continue;
    findings.push(finding(
      'page-usability-clickable-noninteractive', 'low', 'Clickable non-interactive element lacks an explicit keyboard contract',
      `A <${tag}> handles click without a native interactive element, role/tabIndex, or keyboard handler visible in the same element.`,
      file, click.index,
      'Prefer button/a. If a custom interaction is unavoidable, provide semantic role, keyboard activation, focusability and visible focus.',
      ['page-usability', 'accessibility', 'keyboard'],
    ));
  }

  const imageMatcher = new RegExp(IMAGE_TAG.source, IMAGE_TAG.flags);
  let image: RegExpExecArray | null;
  while ((image = imageMatcher.exec(file.text)) !== null) {
    if (/\balt\s*=/.test(image[1] ?? '')) continue;
    findings.push(finding(
      'page-usability-image-alt-missing', 'low', 'Image element has no explicit alt contract',
      'Every img should declare meaningful alt text or alt="" for a decorative image so screen readers receive deterministic semantics.',
      file, image.index,
      'Add a meaningful alt value, or alt="" when the image is purely decorative and redundant with nearby content.',
      ['page-usability', 'accessibility', 'image'],
    ));
  }

  const linkMatcher = new RegExp(ANCHOR_BLANK.source, ANCHOR_BLANK.flags);
  let link: RegExpExecArray | null;
  while ((link = linkMatcher.exec(file.text)) !== null) {
    const attributes = link[1] ?? '';
    const rel = attributes.match(/\brel\s*=\s*(?:['"]([^'"]*)['"]|\{['"]([^'"]*)['"]\})/i);
    const value = `${rel?.[1] ?? ''} ${rel?.[2] ?? ''}`.toLowerCase();
    if (/\bnoopener\b/.test(value)) continue;
    findings.push(finding(
      'page-usability-blank-target-noopener', 'low', 'New-tab link omits noopener',
      'target="_blank" should make opener isolation explicit and keep navigation behavior reviewable.',
      file, link.index,
      'Add rel="noopener noreferrer" unless a documented same-origin opener relationship is required.',
      ['page-usability', 'accessibility', 'navigation'],
    ));
  }
  return findings;
}

function styleFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const outlineMatcher = new RegExp(OUTLINE_SUPPRESSION.source, OUTLINE_SUPPRESSION.flags);
  let outline: RegExpExecArray | null;
  while ((outline = outlineMatcher.exec(file.text)) !== null) {
    findings.push(finding(
      'page-usability-outline-suppressed', 'info', 'CSS suppresses the browser outline',
      'Removing outlines is safe only when the same component has an equally visible :focus-visible treatment.',
      file, outline.index,
      'Keep the default outline or pair the suppression with an obvious focus-visible ring that survives high-contrast modes.',
      ['page-usability', 'accessibility', 'focus'],
    ));
  }

  const widthMatcher = new RegExp(FIXED_WIDTH.source, FIXED_WIDTH.flags);
  let width: RegExpExecArray | null;
  while ((width = widthMatcher.exec(file.text)) !== null) {
    const value = Number.parseFloat(width[1] ?? '0');
    if (!Number.isFinite(value) || value < 720) continue;
    findings.push(finding(
      'page-usability-large-fixed-width', 'info', 'Large fixed pixel width can constrain responsive layouts',
      `${value}px is large enough to overflow common mobile/tablet viewports when not bounded by a responsive override.`,
      file, width.index,
      'Prefer max-width with relative/clamp units, container queries, or an explicit narrow-viewport override.',
      ['page-usability', 'responsive', 'layout'],
    ));
  }

  const overflowMatcher = new RegExp(GLOBAL_OVERFLOW.source, GLOBAL_OVERFLOW.flags);
  let overflow: RegExpExecArray | null;
  while ((overflow = overflowMatcher.exec(file.text)) !== null) {
    findings.push(finding(
      'page-usability-global-overflow-hidden', 'low', 'Global root overflow is hidden',
      'Hiding overflow on html/body/root can make keyboard-focused or zoomed content unreachable.',
      file, overflow.index,
      'Avoid global overflow clipping; constrain the specific visual layer and preserve document scrolling/zoom access.',
      ['page-usability', 'responsive', 'zoom'],
    ));
  }
  return findings;
}

export function auditPageUsabilityGovernance(
  inventory: RepositoryInventory,
): AuditSection<PageUsabilityGovernanceSummary> {
  const started = performance.now();
  const components = componentFiles(inventory);
  const styles = styleFiles(inventory);
  const signals = [
    ...components.map(componentSignal),
    ...styles.map(styleSignal),
  ].sort((left, right) => left.file.localeCompare(right.file));
  const allFindings = stableSortFindings([
    ...components.flatMap(componentFindings),
    ...styles.flatMap(styleFindings),
  ]);
  const findings = allFindings.slice(0, MAX_FINDINGS);
  return {
    domain: 'accessibility',
    title: 'Whole-page usability governance audit',
    summary: {
      files: signals,
      componentFiles: components.length,
      styleFiles: styles.length,
      interactionFiles: signals.filter(item => item.clickHandlers > 0).length,
      responsiveRiskFiles: signals.filter(item => item.largeFixedWidths > 0 || item.globalOverflowHidden > 0).length,
      accessibilityRiskFiles: signals.filter(item => item.clickableNonInteractive > 0 || item.imagesWithoutAlt > 0 || item.outlineSuppressions > 0).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
