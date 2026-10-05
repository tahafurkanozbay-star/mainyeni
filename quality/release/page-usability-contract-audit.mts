import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface PageUsabilitySignal {
  readonly file: string;
  readonly kind: 'tsx' | 'html' | 'css';
  readonly mainLandmarks: number;
  readonly navLandmarks: number;
  readonly headings: number;
  readonly dialogs: number;
  readonly forms: number;
  readonly formControls: number;
  readonly liveRegions: number;
  readonly busyStates: number;
  readonly targetBlankLinks: number;
  readonly unsafeTargetBlankLinks: number;
  readonly zoomRestrictions: number;
  readonly rootScrollLocks: number;
  readonly smallTouchTargets: number;
  readonly legacyViewportUnits: number;
  readonly fixedSurfaces: number;
}

export interface PageUsabilityContractSummary {
  readonly files: readonly PageUsabilitySignal[];
  readonly inspectedFiles: number;
  readonly landmarkFiles: number;
  readonly formFiles: number;
  readonly dialogFiles: number;
  readonly liveRegionFiles: number;
  readonly findings: readonly Finding[];
}

const PRODUCT_TSX = /^Webclient\.app\/src\/.*\.tsx$/i;
const PRODUCT_HTML = /^Webclient\.app\/(?:index\.html|public\/.*\.html)$/i;
const PRODUCT_CSS = /^Webclient\.app\/src\/.*\.css$/i;
const TEST_OR_GENERATED = /(?:^|\/)(?:__tests__|fixtures?|snapshots?|coverage|dist|build|node_modules)(?:\/|$)|\.(?:test|spec)\./i;
const MAIN = /<main(?:\s|>)/gi;
const NAV = /<(?:nav)(?:\s|>)|role\s*=\s*["']navigation["']/gi;
const HEADING = /<h[1-6](?:\s|>)/gi;
const FORM = /<form(?:\s|>)/gi;
const FORM_CONTROL = /<(?:input|select|textarea)(?:\s|>)/gi;
const DIALOG = /role\s*=\s*["'](?:dialog|alertdialog)["']|<dialog(?:\s|>)/gi;
const LIVE_REGION = /role\s*=\s*["'](?:status|alert|log)["']|aria-live\s*=/gi;
const BUSY_STATE = /aria-busy\s*=|\b(?:isLoading|loading|isPending|pending|isFetching|fetching)\b/gi;
const TARGET_BLANK = /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi;
const REL_SAFE = /\brel\s*=\s*["'][^"']*\bnoopener\b[^"']*["']/i;
const VIEWPORT_RESTRICTION = /(?:user-scalable\s*=\s*no|maximum-scale\s*=\s*(?:1(?:\.0+)?)(?:[,"']|$)|minimum-scale\s*=\s*(?:1(?:\.0+)?)(?:[,"']|$))/gi;
const ROOT_SCROLL_LOCK = /(?:^|[}\s,])(?:html|body|#root|#app)\s*(?:,\s*(?:html|body|#root|#app)\s*)*\{[^}]*\boverflow(?:-y)?\s*:\s*hidden\b/gi;
const TOUCH_DIMENSION = /(?:min-)?(?:width|height)\s*:\s*(\d+(?:\.\d+)?)px\b/gi;
const INTERACTIVE_SELECTOR = /(?:button|\[role=["']button["']\]|\.btn\b|\.button\b|\.action\b|\.control\b|\.toolbar[^,{]*)/i;
const LEGACY_VH = /(?:^|[\s:(])(?:height|min-height|max-height)\s*:\s*(?:100|[89]\d)vh\b/gi;
const MODERN_VH = /(?:^|[\s:(])(?:height|min-height|max-height)\s*:\s*[^;{}]*(?:dvh|svh|lvh)\b/i;
const FIXED = /position\s*:\s*fixed\b/gi;
const DIALOG_NAME = /aria-(?:label|labelledby)\s*=/i;
const DIALOG_MODAL = /aria-modal\s*=\s*(?:["']true["']|\{true\})/i;
const LABEL_ASSOCIATION = /<(?:label)\b|aria-(?:label|labelledby)\s*=|\bid\s*=|\bname\s*=/i;
const PAGE_SHELL = /(?:^|\/)(?:App|Root|Shell|Layout|Page|Workspace|Home|Index|KentRehberi)[A-Za-z0-9_-]*\.tsx$/i;
const ASYNC_COMPONENT = /\b(?:isLoading|loading|isPending|pending|isFetching|fetching|error|isError)\b/;
const STATUS_SEMANTICS = /role\s*=\s*["'](?:status|alert)["']|aria-live\s*=|aria-busy\s*=/i;

function count(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let total = 0;
  while (matcher.exec(text) !== null) total += 1;
  return total;
}

function firstLine(file: SourceFile, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.replaceAll('g', ''));
  const lines = file.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (matcher.test(lines[index] ?? '')) return index + 1;
  }
  return 1;
}

function kind(file: SourceFile): PageUsabilitySignal['kind'] | undefined {
  if (PRODUCT_TSX.test(file.repositoryPath)) return 'tsx';
  if (PRODUCT_HTML.test(file.repositoryPath)) return 'html';
  if (PRODUCT_CSS.test(file.repositoryPath)) return 'css';
  return undefined;
}

function eligible(file: SourceFile): boolean {
  return kind(file) !== undefined && !TEST_OR_GENERATED.test(file.repositoryPath);
}

function targetBlankCounts(text: string): { total: number; unsafe: number } {
  const matcher = new RegExp(TARGET_BLANK.source, TARGET_BLANK.flags);
  let total = 0;
  let unsafe = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    total += 1;
    if (!REL_SAFE.test(match[0] ?? '')) unsafe += 1;
  }
  return { total, unsafe };
}

function smallTouchTargets(text: string): number {
  const blocks = text.split('}');
  let total = 0;
  for (const block of blocks) {
    const [selector = '', body = ''] = block.split('{', 2);
    if (!INTERACTIVE_SELECTOR.test(selector)) continue;
    const matcher = new RegExp(TOUCH_DIMENSION.source, TOUCH_DIMENSION.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(body)) !== null) {
      const pixels = Number(match[1]);
      if (Number.isFinite(pixels) && pixels > 0 && pixels < 40) total += 1;
    }
  }
  return total;
}

function signal(file: SourceFile): PageUsabilitySignal {
  const fileKind = kind(file) ?? 'tsx';
  const blank = targetBlankCounts(file.text);
  return {
    file: file.repositoryPath,
    kind: fileKind,
    mainLandmarks: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, MAIN) : 0,
    navLandmarks: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, NAV) : 0,
    headings: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, HEADING) : 0,
    dialogs: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, DIALOG) : 0,
    forms: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, FORM) : 0,
    formControls: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, FORM_CONTROL) : 0,
    liveRegions: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, LIVE_REGION) : 0,
    busyStates: fileKind === 'tsx' || fileKind === 'html' ? count(file.text, BUSY_STATE) : 0,
    targetBlankLinks: blank.total,
    unsafeTargetBlankLinks: blank.unsafe,
    zoomRestrictions: fileKind === 'html' ? count(file.text, VIEWPORT_RESTRICTION) : 0,
    rootScrollLocks: fileKind === 'css' ? count(file.text, ROOT_SCROLL_LOCK) : 0,
    smallTouchTargets: fileKind === 'css' ? smallTouchTargets(file.text) : 0,
    legacyViewportUnits: fileKind === 'css' ? count(file.text, LEGACY_VH) : 0,
    fixedSurfaces: fileKind === 'css' ? count(file.text, FIXED) : 0,
  };
}

function finding(
  current: PageUsabilitySignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  pattern?: RegExp,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'accessibility',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: current.file, line: pattern ? firstLineFromSignal(current, pattern) : 1 },
    evidence: {
      metadata: {
        kind: current.kind,
        mainLandmarks: current.mainLandmarks,
        headings: current.headings,
        dialogs: current.dialogs,
        forms: current.forms,
      },
    },
    remediation,
    tags: ['usability', 'accessibility', 'whole-page', current.kind],
  };
}

const SIGNAL_FILES = new Map<string, SourceFile>();

function firstLineFromSignal(current: PageUsabilitySignal, pattern: RegExp): number {
  const file = SIGNAL_FILES.get(current.file);
  return file ? firstLine(file, pattern) : 1;
}

function shellFindings(file: SourceFile, current: PageUsabilitySignal): Finding[] {
  if (current.kind !== 'tsx' || !PAGE_SHELL.test(current.file)) return [];
  const findings: Finding[] = [];
  if (current.mainLandmarks === 0) {
    findings.push(finding(current, 'page-shell-main-landmark-missing', 'medium', 'Page shell has no main landmark', 'A page-level shell should expose one semantic main region so keyboard and assistive-technology users can reach primary content predictably.', 'Render the primary application workspace inside one <main> landmark or a single role="main" region owned by the shell.'));
  }
  if (current.mainLandmarks > 1) {
    findings.push(finding(current, 'page-shell-main-landmark-duplicated', 'medium', 'Page shell exposes multiple main landmarks', `The shell contains ${current.mainLandmarks} main landmarks, making primary-content navigation ambiguous.`, 'Keep one top-level main landmark; use section/article/region with accessible names for nested workspaces.', MAIN));
  }
  if (current.headings === 0 && /return\s*\(|<Routes?\b|<Outlet\b|workspace/i.test(file.text)) {
    findings.push(finding(current, 'page-shell-heading-contract-missing', 'low', 'Page shell has no static heading contract', 'A page workspace without a discoverable heading can make orientation difficult after navigation or mode changes.', 'Ensure the rendered route/workspace contributes a meaningful h1/h2 hierarchy or a documented dynamically owned heading.'));
  }
  return findings;
}

function dialogFindings(file: SourceFile, current: PageUsabilitySignal): Finding[] {
  if (current.kind !== 'tsx' || current.dialogs === 0) return [];
  const findings: Finding[] = [];
  const dialogFragments = file.text.split(/role\s*=\s*["'](?:dialog|alertdialog)["']|<dialog(?:\s|>)/i).slice(1);
  for (const fragment of dialogFragments) {
    const sample = fragment.slice(0, 900);
    if (!DIALOG_NAME.test(sample)) {
      findings.push(finding(current, 'dialog-accessible-name-missing', 'medium', 'Dialog lacks a visible/ARIA naming contract', 'Dialog surfaces require a stable accessible name so users understand context when focus moves into the overlay.', 'Bind aria-labelledby to the dialog heading or provide a concise aria-label when no visible heading exists.', DIALOG));
      break;
    }
  }
  if (/role\s*=\s*["']dialog["']/i.test(file.text) && !DIALOG_MODAL.test(file.text) && /(?:modal|overlay|drawer|sheet)/i.test(current.file + file.text.slice(0, 1500))) {
    findings.push(finding(current, 'modal-dialog-modality-ambiguous', 'low', 'Modal-looking dialog does not declare modal semantics', 'A blocking overlay that is not exposed as modal can leave background content reachable to assistive technology while visual users cannot interact with it.', 'For truly blocking overlays set aria-modal="true" and enforce focus return/trap semantics; otherwise keep the surface explicitly non-modal.', DIALOG));
  }
  return findings;
}

function formFindings(file: SourceFile, current: PageUsabilitySignal): Finding[] {
  if ((current.kind !== 'tsx' && current.kind !== 'html') || current.formControls === 0) return [];
  const findings: Finding[] = [];
  const controls = file.text.match(/<(?:input|select|textarea)\b[^>]*>/gi) ?? [];
  let unnamed = 0;
  for (const control of controls) {
    if (/\btype\s*=\s*["']hidden["']/i.test(control)) continue;
    if (!LABEL_ASSOCIATION.test(control) && !/\bplaceholder\s*=/i.test(control)) unnamed += 1;
  }
  if (unnamed > 0 && !/<label\b/i.test(file.text)) {
    findings.push(finding(current, 'form-control-label-contract-missing', 'medium', 'Form controls lack an explicit labeling contract', `${unnamed} visible form control(s) have no local id/name/ARIA label signal and the file contains no label element.`, 'Associate visible labels with htmlFor/id or use aria-label/aria-labelledby for controls whose visual label is provided elsewhere.', FORM_CONTROL));
  }
  return findings;
}

function asyncFindings(file: SourceFile, current: PageUsabilitySignal): Finding[] {
  if (current.kind !== 'tsx' || !ASYNC_COMPONENT.test(file.text)) return [];
  if (STATUS_SEMANTICS.test(file.text)) return [];
  return [finding(current, 'async-status-announcement-contract-missing', 'low', 'Async UI state has no status announcement contract', 'The component models loading/pending/error state but exposes no aria-busy, status, alert, or live-region signal in the same module.', 'Expose aria-busy on the affected region and announce meaningful completion/error changes through a bounded status/alert live region.')];
}

function linkFindings(current: PageUsabilitySignal): Finding[] {
  if (current.unsafeTargetBlankLinks === 0) return [];
  return [finding(current, 'external-target-blank-rel-missing', 'medium', 'New-tab link is missing noopener protection', `${current.unsafeTargetBlankLinks} target="_blank" link(s) do not visibly include rel="noopener".`, 'Add rel="noopener noreferrer" to external new-tab links and retain a clear accessible indication that the destination opens separately.', TARGET_BLANK)];
}

function htmlFindings(current: PageUsabilitySignal): Finding[] {
  if (current.kind !== 'html' || current.zoomRestrictions === 0) return [];
  return [finding(current, 'viewport-user-zoom-disabled', 'high', 'Viewport configuration restricts user zoom', 'The document viewport constrains pinch/browser zoom, which blocks an essential low-vision interaction.', 'Remove user-scalable=no and restrictive maximum/minimum-scale values. Keep width=device-width and initial-scale=1 only.', VIEWPORT_RESTRICTION, true)];
}

function cssFindings(file: SourceFile, current: PageUsabilitySignal): Finding[] {
  if (current.kind !== 'css') return [];
  const findings: Finding[] = [];
  if (current.rootScrollLocks > 0) findings.push(finding(current, 'root-scroll-lock-review', 'medium', 'Root page scrolling is globally locked', 'A global html/body/#root overflow lock can make content unreachable at browser zoom, small viewport heights, or when overlays fail to restore state.', 'Prefer component-scoped scroll containers. If an overlay temporarily locks body scrolling, implement bounded lifecycle restoration in runtime code rather than permanent CSS.', ROOT_SCROLL_LOCK));
  if (current.smallTouchTargets > 0) findings.push(finding(current, 'interactive-touch-target-small', 'low', 'Interactive CSS declares a small pointer target', `${current.smallTouchTargets} width/height declaration(s) below 40px were found on button/control-like selectors.`, 'Provide an effective coarse-pointer target close to 44×44 CSS pixels using min-size, padding, or an expanded hit area without distorting visual density.', TOUCH_DIMENSION));
  if (current.legacyViewportUnits > 0 && !MODERN_VH.test(file.text)) findings.push(finding(current, 'mobile-viewport-static-vh', 'low', 'Full-height surface relies only on legacy vh units', `${current.legacyViewportUnits} near-full viewport height declaration(s) use vh without a dvh/svh/lvh companion. Mobile browser chrome can obscure content.`, 'Add a progressive dvh/svh override or use a layout that derives available height from a bounded container.', LEGACY_VH));
  if (current.fixedSurfaces > 0 && !/(?:env\(safe-area-inset-|max-height\s*:|overflow(?:-y)?\s*:\s*(?:auto|scroll))/i.test(file.text)) findings.push(finding(current, 'fixed-surface-viewport-safety-review', 'info', 'Fixed surface has no visible viewport-safety companion', 'Fixed-position UI can cover content on small/zoomed displays when it lacks safe-area, max-height, or overflow behavior.', 'For persistent fixed controls, validate safe-area insets and constrained-height overflow at narrow widths and 200–400% zoom.', FIXED));
  return findings;
}

function findingsFor(file: SourceFile, current: PageUsabilitySignal): Finding[] {
  return [...shellFindings(file, current), ...dialogFindings(file, current), ...formFindings(file, current), ...asyncFindings(file, current), ...linkFindings(current), ...htmlFindings(current), ...cssFindings(file, current)];
}

export function auditPageUsabilityContracts(inventory: RepositoryInventory): AuditSection<PageUsabilityContractSummary> {
  const started = performance.now();
  const files = inventory.files.filter(eligible);
  SIGNAL_FILES.clear();
  for (const file of files) SIGNAL_FILES.set(file.repositoryPath, file);
  const signals = files.map(signal).sort((left, right) => left.file.localeCompare(right.file, 'en'));
  const byPath = new Map(files.map(file => [file.repositoryPath, file]));
  const findings = stableSortFindings(signals.flatMap(current => {
    const file = byPath.get(current.file);
    return file ? findingsFor(file, current) : [];
  }));
  return {
    domain: 'accessibility',
    title: 'Whole-page usability contract audit',
    summary: {
      files: signals,
      inspectedFiles: signals.length,
      landmarkFiles: signals.filter(item => item.mainLandmarks + item.navLandmarks > 0).length,
      formFiles: signals.filter(item => item.formControls > 0).length,
      dialogFiles: signals.filter(item => item.dialogs > 0).length,
      liveRegionFiles: signals.filter(item => item.liveRegions > 0).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
