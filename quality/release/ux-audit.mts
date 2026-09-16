import {
  stableSortFindings,
  type AccessibilitySignal,
  type AccessibilitySummary,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, selectWebSource, snippetAround } from './inventory.mts';

export interface ResponsiveSignal {
  readonly file: string;
  readonly mediaQueries: number;
  readonly containerQueries: number;
  readonly viewportUnits: number;
  readonly fixedPixels: number;
  readonly overflowHidden: number;
  readonly reducedMotionRules: number;
  readonly forcedColorsRules: number;
  readonly colorSchemeRules: number;
}

export interface UxAuditDetails extends AccessibilitySummary {
  readonly responsiveSignals: readonly ResponsiveSignal[];
  readonly responsiveFiles: number;
  readonly reducedMotionFiles: number;
  readonly forcedColorsFiles: number;
}

const INTERACTIVE_TAG_PATTERN = /<(?:button|a\b|input|select|textarea)\b/gi;
const CLICK_HANDLER_PATTERN = /\bonClick\s*=|addEventListener\s*\(\s*['"]click['"]/gi;
const KEYBOARD_HANDLER_PATTERN = /\bonKey(?:Down|Up|Press)\s*=|addEventListener\s*\(\s*['"]key(?:down|up|press)['"]/gi;
const ARIA_LABEL_PATTERN = /\baria-(?:label|labelledby|describedby)\s*=/gi;
const LABEL_PATTERN = /<label\b|\baria-label\s*=|\baria-labelledby\s*=/gi;
const IMAGE_PATTERN = /<img\b/gi;
const ALT_PATTERN = /\balt\s*=/gi;
const POSITIVE_TABINDEX_PATTERN = /tabIndex\s*=\s*\{?\s*[1-9]\d*\s*\}?|tabindex\s*=\s*['"]?[1-9]\d*/gi;
const RAW_TABINDEX_PATTERN = /tabIndex\s*=|tabindex\s*=/gi;
const CLICKABLE_DIV_PATTERN = /<(?:div|span|li)\b[^>]*\bonClick\s*=/gi;
const ROLE_PATTERN = /\brole\s*=\s*['"](?:button|link|menuitem|option|checkbox|radio|tab)['"]/gi;
const AUTOFIELD_PATTERN = /\bautoFocus(?:\s|=|\/?>)/gi;
const OUTLINE_NONE_PATTERN = /outline\s*:\s*(?:none|0)\b/gi;
const POINTER_CURSOR_PATTERN = /cursor\s*:\s*pointer/gi;
const MEDIA_QUERY_PATTERN = /@media\b/gi;
const CONTAINER_QUERY_PATTERN = /@container\b/gi;
const VIEWPORT_UNIT_PATTERN = /\b\d+(?:\.\d+)?(?:vw|vh|dvh|svh|lvh|vmin|vmax)\b/gi;
const FIXED_PIXEL_PATTERN = /\b(?:width|height|min-width|min-height|max-width|max-height)\s*:\s*\d{3,}px\b/gi;
const OVERFLOW_HIDDEN_PATTERN = /overflow(?:-[xy])?\s*:\s*hidden\b/gi;
const REDUCED_MOTION_PATTERN = /prefers-reduced-motion/gi;
const FORCED_COLORS_PATTERN = /forced-colors/gi;
const COLOR_SCHEME_PATTERN = /prefers-color-scheme|color-scheme\s*:/gi;

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

function componentName(file: SourceFile): string | null {
  const match = file.text.match(/(?:function|class|const)\s+([A-Z][A-Za-z0-9_$]*)\b/);
  return match?.[1] ?? null;
}

function accessibilitySignal(file: SourceFile): AccessibilitySignal {
  return {
    file: file.repositoryPath,
    component: componentName(file),
    interactiveElements: count(file.text, INTERACTIVE_TAG_PATTERN),
    ariaLabels: count(file.text, ARIA_LABEL_PATTERN),
    labels: count(file.text, LABEL_PATTERN),
    keyboardHandlers: count(file.text, KEYBOARD_HANDLER_PATTERN),
    clickHandlers: count(file.text, CLICK_HANDLER_PATTERN),
    rawTabIndexes: count(file.text, RAW_TABINDEX_PATTERN),
    dangerousPositiveTabIndexes: count(file.text, POSITIVE_TABINDEX_PATTERN),
    imageElements: count(file.text, IMAGE_PATTERN),
    altAttributes: count(file.text, ALT_PATTERN),
  };
}

function responsiveSignal(file: SourceFile): ResponsiveSignal {
  return {
    file: file.repositoryPath,
    mediaQueries: count(file.text, MEDIA_QUERY_PATTERN),
    containerQueries: count(file.text, CONTAINER_QUERY_PATTERN),
    viewportUnits: count(file.text, VIEWPORT_UNIT_PATTERN),
    fixedPixels: count(file.text, FIXED_PIXEL_PATTERN),
    overflowHidden: count(file.text, OVERFLOW_HIDDEN_PATTERN),
    reducedMotionRules: count(file.text, REDUCED_MOTION_PATTERN),
    forcedColorsRules: count(file.text, FORCED_COLORS_PATTERN),
    colorSchemeRules: count(file.text, COLOR_SCHEME_PATTERN),
  };
}

function clickableNonSemanticFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const lineIndex = createLineIndex(file.text);
  const matcher = new RegExp(CLICKABLE_DIV_PATTERN.source, CLICKABLE_DIV_PATTERN.flags);
  let match: RegExpExecArray | null;
  let emitted = 0;
  while ((match = matcher.exec(file.text)) !== null) {
    const tagEnd = file.text.indexOf('>', match.index);
    const fragment = file.text.slice(match.index, tagEnd >= 0 ? Math.min(tagEnd + 1, match.index + 1200) : match.index + 600);
    const hasRole = ROLE_PATTERN.test(fragment);
    ROLE_PATTERN.lastIndex = 0;
    const hasKeyboard = KEYBOARD_HANDLER_PATTERN.test(fragment);
    KEYBOARD_HANDLER_PATTERN.lastIndex = 0;
    if (!hasRole || !hasKeyboard) {
      findings.push({
        id: 'a11y-clickable-nonsemantic-control',
        domain: 'accessibility',
        severity: 'medium',
        title: 'Clickable non-semantic element',
        message: 'Clickable div/span/li controls require semantic role, keyboard behavior and focusability; native button/link is preferred.',
        location: { file: file.repositoryPath, line: lineIndex.lineAt(match.index) },
        evidence: { excerpt: snippetAround(file.text, match.index, 140) },
        remediation: 'Use a native button/link where possible; otherwise implement the complete keyboard/role/focus contract.',
        tags: ['keyboard', 'semantics'],
      });
    }
    emitted += 1;
    if (emitted >= 12) break;
  }
  return findings;
}

function positiveTabIndexFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const lineIndex = createLineIndex(file.text);
  const matcher = new RegExp(POSITIVE_TABINDEX_PATTERN.source, POSITIVE_TABINDEX_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: 'a11y-positive-tabindex',
      domain: 'accessibility',
      severity: 'high',
      title: 'Positive tabindex disrupts document order',
      message: 'Positive tabindex values create brittle keyboard focus ordering.',
      location: { file: file.repositoryPath, line: lineIndex.lineAt(match.index) },
      evidence: { excerpt: snippetAround(file.text, match.index, 80) },
      remediation: 'Use DOM order and tabindex=0/-1 with roving-focus patterns where necessary.',
      tags: ['keyboard', 'focus'],
    });
  }
  return findings;
}

function imageAltFindings(file: SourceFile, signal: AccessibilitySignal): Finding[] {
  if (signal.imageElements === 0 || signal.altAttributes >= signal.imageElements) return [];
  return [{
    id: 'a11y-image-alt-coverage',
    domain: 'accessibility',
    severity: 'medium',
    title: 'Image alt coverage review',
    message: `${signal.imageElements} img elements but only ${signal.altAttributes} alt attributes were detected.`,
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'Give meaningful images text alternatives and decorative images alt="".',
    tags: ['images'],
  }];
}

function autofocusFindings(file: SourceFile): Finding[] {
  const matches = [...file.text.matchAll(new RegExp(AUTOFIELD_PATTERN.source, AUTOFIELD_PATTERN.flags))];
  if (matches.length === 0) return [];
  return [{
    id: 'a11y-autofocus-review',
    domain: 'accessibility',
    severity: 'low',
    title: 'Autofocus behavior requires review',
    message: 'Automatic focus can disorient screen-reader and mobile users when surfaces mount.',
    location: { file: file.repositoryPath, line: 1 },
    evidence: { value: matches.length },
    remediation: 'Prefer deliberate focus management after user-triggered navigation/dialog open.',
    tags: ['focus'],
  }];
}

function cssFindings(file: SourceFile, signal: ResponsiveSignal): Finding[] {
  const findings: Finding[] = [];
  if (signal.fixedPixels >= 12 && signal.mediaQueries === 0 && signal.containerQueries === 0) {
    findings.push({
      id: 'responsive-fixed-layout-without-breakpoint',
      domain: 'responsive',
      severity: 'medium',
      title: 'Fixed-size layout without responsive rule',
      message: 'Many large fixed pixel dimensions were detected without media/container queries in the same stylesheet.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { metadata: { fixedPixels: signal.fixedPixels, mediaQueries: signal.mediaQueries } },
      remediation: 'Use fluid sizing, clamp/min/max and tested breakpoints where the component needs adaptation.',
      tags: ['responsive'],
    });
  }
  if (signal.overflowHidden >= 8) {
    findings.push({
      id: 'responsive-overflow-hidden-heavy',
      domain: 'responsive',
      severity: 'low',
      title: 'Heavy overflow clipping',
      message: 'Frequent overflow:hidden can clip focus rings, popovers, map controls and zoomed content.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { value: signal.overflowHidden },
      remediation: 'Verify keyboard focus, 200% zoom, mobile viewport and ArcGIS popup/control overflow.',
      tags: ['zoom', 'focus'],
    });
  }
  const outlineNoneCount = count(file.text, OUTLINE_NONE_PATTERN);
  if (outlineNoneCount > 0 && !/:focus-visible|box-shadow\s*:|outline\s*:\s*[^0n]/i.test(file.text)) {
    findings.push({
      id: 'a11y-focus-outline-removed',
      domain: 'accessibility',
      severity: 'high',
      title: 'Focus outline removed without visible replacement',
      message: 'Keyboard focus may become invisible.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { value: outlineNoneCount },
      remediation: 'Provide a high-contrast :focus-visible indicator before removing native outline.',
      tags: ['focus', 'css'],
    });
  }
  const pointerCount = count(file.text, POINTER_CURSOR_PATTERN);
  if (pointerCount > 25 && signal.forcedColorsRules === 0) {
    findings.push({
      id: 'a11y-interactive-css-forced-colors-review',
      domain: 'accessibility',
      severity: 'low',
      title: 'Dense interactive CSS lacks forced-colors rule',
      message: 'High-interaction styles should be checked in Windows High Contrast / forced-colors mode.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { value: pointerCount },
      remediation: 'Add targeted forced-colors overrides only where visual semantics disappear.',
      tags: ['forced-colors'],
    });
  }
  return findings;
}

export function auditUx(inventory: RepositoryInventory): AuditSection<UxAuditDetails> {
  const start = performance.now();
  const webFiles = selectWebSource(inventory).filter(file => !file.repositoryPath.startsWith('quality/release/'));
  const componentFiles = webFiles.filter(file => ['javascript', 'typescript'].includes(file.kind) && /\.(?:jsx?|tsx?)$/.test(file.repositoryPath));
  const cssFiles = webFiles.filter(file => file.kind === 'css');
  const signals = componentFiles.map(accessibilitySignal);
  const responsiveSignals = cssFiles.map(responsiveSignal);
  const findings: Finding[] = [];

  for (const file of componentFiles) {
    const signal = signals.find(item => item.file === file.repositoryPath) ?? accessibilitySignal(file);
    findings.push(...clickableNonSemanticFindings(file));
    findings.push(...positiveTabIndexFindings(file));
    findings.push(...imageAltFindings(file, signal));
    findings.push(...autofocusFindings(file));
    if (signal.clickHandlers >= 8 && signal.keyboardHandlers === 0 && signal.interactiveElements === 0) {
      findings.push({
        id: 'a11y-click-heavy-without-keyboard-signals',
        domain: 'accessibility',
        severity: 'medium',
        title: 'Click-heavy component lacks keyboard signals',
        message: 'The component has many click handlers but no semantic interactive tags or keyboard handlers were detected.',
        location: { file: file.repositoryPath, line: 1 },
        evidence: { metadata: { clickHandlers: signal.clickHandlers, keyboardHandlers: signal.keyboardHandlers } },
        remediation: 'Audit the interaction surface with keyboard-only and screen-reader smoke tests.',
        tags: ['keyboard'],
      });
    }
  }

  for (const file of cssFiles) {
    const signal = responsiveSignals.find(item => item.file === file.repositoryPath) ?? responsiveSignal(file);
    findings.push(...cssFindings(file, signal));
  }

  const totalCssLines = cssFiles.reduce((sum, file) => sum + file.lines, 0);
  const reducedMotionFiles = responsiveSignals.filter(signal => signal.reducedMotionRules > 0).length;
  const forcedColorsFiles = responsiveSignals.filter(signal => signal.forcedColorsRules > 0).length;
  if (totalCssLines > 1500 && reducedMotionFiles === 0) {
    findings.push({
      id: 'a11y-reduced-motion-contract-missing',
      domain: 'accessibility',
      severity: 'medium',
      title: 'Reduced-motion contract not detected',
      message: 'A substantial CSS surface exists but no prefers-reduced-motion handling was detected.',
      remediation: 'Disable or reduce non-essential transitions/animations when the user requests reduced motion.',
      tags: ['motion'],
    });
  }

  const sorted = stableSortFindings(findings);
  return {
    domain: 'accessibility',
    title: 'Accessibility and responsive static audit',
    summary: {
      signals,
      findings: sorted,
      interactiveElementCount: signals.reduce((sum, signal) => sum + signal.interactiveElements, 0),
      labelledControlCount: signals.reduce((sum, signal) => sum + signal.labels + signal.ariaLabels, 0),
      keyboardHandlerCount: signals.reduce((sum, signal) => sum + signal.keyboardHandlers, 0),
      responsiveSignals,
      responsiveFiles: responsiveSignals.filter(signal => signal.mediaQueries > 0 || signal.containerQueries > 0).length,
      reducedMotionFiles,
      forcedColorsFiles,
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
