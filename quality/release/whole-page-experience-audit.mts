import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface WholePageFileSignal {
  readonly file: string;
  readonly kind: 'tsx' | 'html' | 'css';
  readonly mainLandmarks: number;
  readonly headings: number;
  readonly interactiveElements: number;
  readonly pointerOnlyElements: number;
  readonly tables: number;
  readonly dialogs: number;
  readonly forms: number;
  readonly animations: number;
  readonly outlineSuppressions: number;
  readonly legacyViewportHeights: number;
  readonly rigidMinWidths: number;
  readonly fixedOrStickySurfaces: number;
}

export interface WholePageExperienceSummary {
  readonly files: readonly WholePageFileSignal[];
  readonly inspectedFiles: number;
  readonly tsxFiles: number;
  readonly cssFiles: number;
  readonly htmlFiles: number;
  readonly mainLandmarks: number;
  readonly headings: number;
  readonly pointerOnlyElements: number;
  readonly tables: number;
  readonly dialogs: number;
  readonly forms: number;
  readonly focusVisibleContract: boolean;
  readonly reducedMotionContract: boolean;
  readonly forcedColorsContract: boolean;
  readonly coarsePointerContract: boolean;
  readonly skipLinkContract: boolean;
  readonly modernViewportContract: boolean;
  readonly responsiveTableContract: boolean;
  readonly findings: readonly Finding[];
}

const PRODUCT_TSX = /^Webclient\.app\/src\/.*\.tsx$/i;
const PRODUCT_HTML = /^Webclient\.app\/(?:index\.html|public\/.*\.html)$/i;
const PRODUCT_CSS = /^Webclient\.app\/src\/.*\.css$/i;
const TEST_OR_GENERATED = /(?:^|\/)(?:__tests__|fixtures?|snapshots?|coverage|dist|build|node_modules|qa-artifacts)(?:\/|$)|\.(?:test|spec)\./i;
const MAIN = /<main(?:\s|>)|role\s*=\s*["']main["']/gi;
const HEADING = /<h[1-6](?:\s|>)/gi;
const INTERACTIVE = /<(?:button|a|input|select|textarea|summary)\b|role\s*=\s*["'](?:button|link|checkbox|radio|switch|tab|menuitem|option|slider|spinbutton|combobox|gridcell)["']/gi;
const TABLE = /<table(?:\s|>)|role\s*=\s*["'](?:table|grid|treegrid)["']/gi;
const DIALOG = /<dialog(?:\s|>)|role\s*=\s*["'](?:dialog|alertdialog)["']/gi;
const FORM = /<form(?:\s|>)/gi;
const ANIMATION = /\b(?:animation|transition)(?:-[a-z-]+)?\s*:/gi;
const OUTLINE_SUPPRESSION = /\boutline\s*:\s*(?:none|0(?:\s+none)?)\b/gi;
const LEGACY_VIEWPORT_HEIGHT = /\b(?:height|min-height|max-height)\s*:\s*(?:100|9\d|8\d)vh\b/gi;
const MODERN_VIEWPORT_HEIGHT = /\b(?:height|min-height|max-height)\s*:[^;{}]*(?:dvh|svh|lvh)\b/i;
const RIGID_MIN_WIDTH = /\bmin-width\s*:\s*(\d+(?:\.\d+)?)px\b/gi;
const FIXED_OR_STICKY = /\bposition\s*:\s*(?:fixed|sticky)\b/gi;
const FOCUS_VISIBLE = /:focus-visible\b|\[data-focus-visible-added\]/i;
const REDUCED_MOTION = /@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/i;
const FORCED_COLORS = /@media\s*\([^)]*forced-colors\s*:\s*active[^)]*\)/i;
const COARSE_POINTER = /@media\s*\([^)]*(?:pointer\s*:\s*coarse|any-pointer\s*:\s*coarse)[^)]*\)/i;
const SKIP_LINK = /(?:skip[-_ ]?(?:link|navigation|content)|href\s*=\s*["']#(?:main|content|main-content)["'])/i;
const RESPONSIVE_TABLE = /(?:overflow-x\s*:\s*(?:auto|scroll)|display\s*:\s*block)[^}]*|(?:table|grid)[^{]*\{[^}]*(?:overflow-x\s*:\s*(?:auto|scroll))/i;
const JSX_OPENING_TAG = /<(div|span|li|section|article|header|footer|aside|p)\b([^>]*)>/gi;
const ON_CLICK = /\bonClick\s*=/i;
const KEYBOARD_SUPPORT = /\bonKey(?:Down|Up|Press)\s*=|\btabIndex\s*=|\brole\s*=\s*["'](?:button|link|checkbox|radio|switch|tab|menuitem|option)["']/i;

function count(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let total = 0;
  while (matcher.exec(text) !== null) total += 1;
  return total;
}

function kind(file: SourceFile): WholePageFileSignal['kind'] | undefined {
  if (PRODUCT_TSX.test(file.repositoryPath)) return 'tsx';
  if (PRODUCT_HTML.test(file.repositoryPath)) return 'html';
  if (PRODUCT_CSS.test(file.repositoryPath)) return 'css';
  return undefined;
}

function eligible(file: SourceFile): boolean {
  return kind(file) !== undefined && !TEST_OR_GENERATED.test(file.repositoryPath);
}

function pointerOnlyElements(text: string): number {
  let total = 0;
  const matcher = new RegExp(JSX_OPENING_TAG.source, JSX_OPENING_TAG.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const attributes = match[2] ?? '';
    if (!ON_CLICK.test(attributes)) continue;
    if (KEYBOARD_SUPPORT.test(attributes)) continue;
    total += 1;
  }
  return total;
}

function rigidMinWidths(text: string): number {
  let total = 0;
  const matcher = new RegExp(RIGID_MIN_WIDTH.source, RIGID_MIN_WIDTH.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 480) total += 1;
  }
  return total;
}

function signal(file: SourceFile): WholePageFileSignal {
  const fileKind = kind(file) ?? 'tsx';
  return {
    file: file.repositoryPath,
    kind: fileKind,
    mainLandmarks: fileKind === 'css' ? 0 : count(file.text, MAIN),
    headings: fileKind === 'css' ? 0 : count(file.text, HEADING),
    interactiveElements: fileKind === 'css' ? 0 : count(file.text, INTERACTIVE),
    pointerOnlyElements: fileKind === 'tsx' ? pointerOnlyElements(file.text) : 0,
    tables: fileKind === 'css' ? 0 : count(file.text, TABLE),
    dialogs: fileKind === 'css' ? 0 : count(file.text, DIALOG),
    forms: fileKind === 'css' ? 0 : count(file.text, FORM),
    animations: fileKind === 'css' ? count(file.text, ANIMATION) : 0,
    outlineSuppressions: fileKind === 'css' ? count(file.text, OUTLINE_SUPPRESSION) : 0,
    legacyViewportHeights: fileKind === 'css' ? count(file.text, LEGACY_VIEWPORT_HEIGHT) : 0,
    rigidMinWidths: fileKind === 'css' ? rigidMinWidths(file.text) : 0,
    fixedOrStickySurfaces: fileKind === 'css' ? count(file.text, FIXED_OR_STICKY) : 0,
  };
}

function firstFile(signals: readonly WholePageFileSignal[], predicate: (signal: WholePageFileSignal) => boolean): string | undefined {
  return signals.find(predicate)?.file;
}

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  file: string | undefined,
  domain: Finding['domain'] = 'accessibility',
  blocking = false,
  value?: number | boolean | string,
): Finding {
  return {
    id,
    domain,
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    ...(file ? { location: { file, line: 1 } } : {}),
    ...(value !== undefined ? { evidence: { value } } : {}),
    remediation,
    tags: ['whole-page', 'usability', 'responsive', 'accessibility'],
  };
}

function aggregateContracts(files: readonly SourceFile[]): {
  focusVisible: boolean;
  reducedMotion: boolean;
  forcedColors: boolean;
  coarsePointer: boolean;
  skipLink: boolean;
  modernViewport: boolean;
  responsiveTable: boolean;
} {
  const css = files.filter(file => kind(file) === 'css').map(file => file.text).join('\n');
  const markup = files.filter(file => kind(file) !== 'css').map(file => file.text).join('\n');
  return {
    focusVisible: FOCUS_VISIBLE.test(css),
    reducedMotion: REDUCED_MOTION.test(css),
    forcedColors: FORCED_COLORS.test(css),
    coarsePointer: COARSE_POINTER.test(css),
    skipLink: SKIP_LINK.test(markup),
    modernViewport: MODERN_VIEWPORT_HEIGHT.test(css),
    responsiveTable: RESPONSIVE_TABLE.test(css),
  };
}

function contractFindings(
  signals: readonly WholePageFileSignal[],
  contracts: ReturnType<typeof aggregateContracts>,
): Finding[] {
  const findings: Finding[] = [];
  const mainLandmarks = signals.reduce((sum, item) => sum + item.mainLandmarks, 0);
  const headings = signals.reduce((sum, item) => sum + item.headings, 0);
  const pointerOnly = signals.reduce((sum, item) => sum + item.pointerOnlyElements, 0);
  const animations = signals.reduce((sum, item) => sum + item.animations, 0);
  const outlineSuppressions = signals.reduce((sum, item) => sum + item.outlineSuppressions, 0);
  const legacyViewport = signals.reduce((sum, item) => sum + item.legacyViewportHeights, 0);
  const rigidWidths = signals.reduce((sum, item) => sum + item.rigidMinWidths, 0);
  const tables = signals.reduce((sum, item) => sum + item.tables, 0);

  if (mainLandmarks === 0) {
    findings.push(finding(
      'whole-page-main-landmark-missing',
      'high',
      'Application exposes no primary main landmark',
      'The inspected product page has no semantic main region, so keyboard and assistive-technology navigation cannot reliably identify primary content.',
      'Expose exactly one page-level <main> or role="main" owner and keep nested workspaces as named regions/sections.',
      signals.find(item => item.kind !== 'css')?.file,
      'accessibility',
      true,
      mainLandmarks,
    ));
  }

  if (headings === 0) {
    findings.push(finding(
      'whole-page-heading-hierarchy-missing',
      'medium',
      'Application page exposes no static heading contract',
      'A complex GIS workspace without a discoverable heading makes route, result and mode changes harder to orient.',
      'Ensure each primary workspace contributes a meaningful heading hierarchy, with one stable top-level page heading contract.',
      signals.find(item => item.kind === 'tsx')?.file,
      'accessibility',
      false,
      headings,
    ));
  }

  if (!contracts.focusVisible && signals.some(item => item.interactiveElements > 0)) {
    findings.push(finding(
      'whole-page-focus-visible-contract-missing',
      'medium',
      'No repository-wide focus-visible styling contract was found',
      'Interactive controls exist, but the CSS surface exposes no :focus-visible contract for keyboard focus discovery.',
      'Provide a high-contrast :focus-visible treatment for links, buttons, controls, rows and map/workspace command surfaces.',
      signals.find(item => item.interactiveElements > 0)?.file,
    ));
  }

  if (animations > 0 && !contracts.reducedMotion) {
    findings.push(finding(
      'whole-page-reduced-motion-contract-missing',
      'medium',
      'Animated UI has no prefers-reduced-motion safety contract',
      `${animations} animation/transition declaration(s) exist without a repository-wide reduced-motion media query.`,
      'Add prefers-reduced-motion: reduce handling that removes non-essential animation while preserving state communication.',
      firstFile(signals, item => item.animations > 0),
      'accessibility',
      false,
      animations,
    ));
  }

  if (!contracts.forcedColors && signals.some(item => item.interactiveElements > 0)) {
    findings.push(finding(
      'whole-page-forced-colors-contract-missing',
      'low',
      'Interactive UI has no forced-colors adaptation contract',
      'Complex custom controls should remain understandable when system high-contrast/forced-colors mode overrides authored colors.',
      'Add a bounded @media (forced-colors: active) contract for focus, selection, borders and icon-only controls.',
      signals.find(item => item.interactiveElements > 0)?.file,
    ));
  }

  if (!contracts.coarsePointer && signals.some(item => item.interactiveElements > 0)) {
    findings.push(finding(
      'whole-page-coarse-pointer-contract-missing',
      'low',
      'Interactive UI has no coarse-pointer adaptation contract',
      'Dense desktop controls can become difficult to operate on touch hardware without pointer-coarse spacing or hit-area governance.',
      'Provide a pointer: coarse/any-pointer: coarse contract for effective hit targets without inflating desktop density.',
      signals.find(item => item.interactiveElements > 0)?.file,
    ));
  }

  if (!contracts.skipLink && mainLandmarks > 0) {
    findings.push(finding(
      'whole-page-skip-link-contract-missing',
      'low',
      'Primary page landmark has no visible skip-navigation contract',
      'Keyboard users may need to traverse persistent navigation/toolbars before reaching the main GIS workspace.',
      'Provide a focus-revealed skip link that targets the stable main/content anchor and remains usable at zoomed/narrow layouts.',
      signals.find(item => item.mainLandmarks > 0)?.file,
    ));
  }

  if (pointerOnly > 0) {
    findings.push(finding(
      'whole-page-pointer-only-interaction',
      'medium',
      'Non-semantic elements expose click interaction without visible keyboard semantics',
      `${pointerOnly} div/span/list/section-like interactive element(s) have onClick without a local keyboard/role/tabIndex contract.`,
      'Prefer native button/link elements. Where a custom semantic is unavoidable, add an appropriate role, focusability and Enter/Space keyboard handling.',
      firstFile(signals, item => item.pointerOnlyElements > 0),
      'accessibility',
      false,
      pointerOnly,
    ));
  }

  if (outlineSuppressions > 0 && !contracts.focusVisible) {
    findings.push(finding(
      'whole-page-focus-outline-suppressed',
      'high',
      'Focus outlines are suppressed without a focus-visible replacement',
      `${outlineSuppressions} outline suppression declaration(s) were found and no repository-wide focus-visible contract exists.`,
      'Never remove focus indication without an equal-or-stronger :focus-visible replacement that survives forced-colors mode.',
      firstFile(signals, item => item.outlineSuppressions > 0),
      'accessibility',
      true,
      outlineSuppressions,
    ));
  }

  if (legacyViewport > 0 && !contracts.modernViewport) {
    findings.push(finding(
      'whole-page-mobile-viewport-legacy-vh',
      'low',
      'Near-full-height layouts rely only on legacy vh units',
      `${legacyViewport} near-full viewport height declaration(s) use vh without a dvh/svh/lvh companion contract.`,
      'Use progressive dvh/svh sizing or container-derived height so browser chrome and virtual keyboards do not hide content.',
      firstFile(signals, item => item.legacyViewportHeights > 0),
      'responsive',
      false,
      legacyViewport,
    ));
  }

  if (rigidWidths > 0) {
    findings.push(finding(
      'whole-page-rigid-mobile-min-width',
      'medium',
      'Large fixed pixel min-width can force horizontal page overflow',
      `${rigidWidths} min-width declaration(s) at or above 480px were found in product CSS.`,
      'Replace page-level rigid minimum widths with min(), clamp(), responsive grid/flex constraints, or component-scoped overflow where tabular data truly requires it.',
      firstFile(signals, item => item.rigidMinWidths > 0),
      'responsive',
      false,
      rigidWidths,
    ));
  }

  if (tables > 0 && !contracts.responsiveTable) {
    findings.push(finding(
      'whole-page-table-responsive-contract-missing',
      'low',
      'Table/grid UI has no visible horizontal-overflow contract',
      `${tables} table/grid surface(s) exist without a repository-level responsive overflow signal.`,
      'Keep semantic table/grid structure, but place wide data in a labelled overflow container or responsive column policy so the whole page never overflows horizontally.',
      firstFile(signals, item => item.tables > 0),
      'responsive',
      false,
      tables,
    ));
  }

  return findings;
}

export function auditWholePageExperience(
  inventory: RepositoryInventory,
): AuditSection<WholePageExperienceSummary> {
  const started = performance.now();
  const files = inventory.files.filter(eligible);
  const signals = files.map(signal).sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const contracts = aggregateContracts(files);
  const findings = stableSortFindings(contractFindings(signals, contracts));
  return {
    domain: 'accessibility',
    title: 'Whole-page usability and responsive resilience audit',
    summary: {
      files: signals,
      inspectedFiles: signals.length,
      tsxFiles: signals.filter(item => item.kind === 'tsx').length,
      cssFiles: signals.filter(item => item.kind === 'css').length,
      htmlFiles: signals.filter(item => item.kind === 'html').length,
      mainLandmarks: signals.reduce((sum, item) => sum + item.mainLandmarks, 0),
      headings: signals.reduce((sum, item) => sum + item.headings, 0),
      pointerOnlyElements: signals.reduce((sum, item) => sum + item.pointerOnlyElements, 0),
      tables: signals.reduce((sum, item) => sum + item.tables, 0),
      dialogs: signals.reduce((sum, item) => sum + item.dialogs, 0),
      forms: signals.reduce((sum, item) => sum + item.forms, 0),
      focusVisibleContract: contracts.focusVisible,
      reducedMotionContract: contracts.reducedMotion,
      forcedColorsContract: contracts.forcedColors,
      coarsePointerContract: contracts.coarsePointer,
      skipLinkContract: contracts.skipLink,
      modernViewportContract: contracts.modernViewport,
      responsiveTableContract: contracts.responsiveTable,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
