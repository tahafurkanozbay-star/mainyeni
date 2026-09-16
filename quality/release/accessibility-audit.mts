import { performance } from 'node:perf_hooks';
import type { AuditSection, Finding, RepositoryInventory, SourceFile } from './contracts.mts';

export interface AccessibilityAuditSummary {
  readonly uiFiles: number;
  readonly cssFiles: number;
  readonly htmlFiles: number;
  readonly interactiveCandidates: number;
  readonly imageCandidates: number;
  readonly labelCandidates: number;
  readonly motionDeclarations: number;
  readonly reducedMotionContracts: number;
  readonly forcedColorContracts: number;
  readonly findingsByRule: Readonly<Record<string, number>>;
}

interface LocatedMatch {
  readonly line: number;
  readonly excerpt: string;
}

const UI_PATH = /(^|\/)(src|Webclient\.app\/src)\//i;
const TEST_PATH = /(^|\/)(__tests__|test|tests|fixtures?|mocks?)(\/|\.|$)/i;
const GENERATED_PATH = /(^|\/)(build|dist|coverage|node_modules)(\/|$)/i;
const JSX_KIND = new Set(['javascript', 'typescript']);

function isUiSource(file: SourceFile): boolean {
  return JSX_KIND.has(file.kind) && UI_PATH.test(file.repositoryPath) && !TEST_PATH.test(file.repositoryPath) && !GENERATED_PATH.test(file.repositoryPath);
}
function isCss(file: SourceFile): boolean { return file.kind === 'css' && !TEST_PATH.test(file.repositoryPath) && !GENERATED_PATH.test(file.repositoryPath); }
function isHtml(file: SourceFile): boolean { return file.kind === 'html' && !TEST_PATH.test(file.repositoryPath) && !GENERATED_PATH.test(file.repositoryPath); }
function lineForOffset(text: string, offset: number): number { let line = 1; for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1; return line; }
function compact(value: string, max = 180): string { const normalized = value.replace(/\s+/g, ' ').trim(); return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`; }
function matches(text: string, pattern: RegExp): LocatedMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const found: LocatedMatch[] = [];
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) { const offset = match.index ?? 0; found.push({ line: lineForOffset(text, offset), excerpt: compact(match[0]) }); }
  return found;
}
function finding(id: string, severity: Finding['severity'], title: string, message: string, file: SourceFile, match: LocatedMatch, remediation: string, tags: readonly string[], blocking = false): Finding {
  return { id, domain: 'accessibility', severity, title, message, location: { file: file.repositoryPath, line: match.line }, evidence: { excerpt: match.excerpt }, remediation, tags, ...(blocking ? { blocking: true } : {}) };
}
function pushLimited(target: Finding[], candidates: readonly Finding[], limit = 12): void { target.push(...candidates.slice(0, limit)); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function auditUiFile(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const positiveTabIndex = matches(file.text, /\btabIndex\s*=\s*[{"']?\s*[1-9]\d*/gi);
  pushLimited(findings, positiveTabIndex.map(match => finding('a11y-positive-tabindex', 'high', 'Positive tab index overrides natural keyboard order', 'Positive tabIndex values create a custom focus order that can diverge from visual and DOM order.', file, match, 'Use semantic DOM order and tabIndex={0} only when a non-native interactive element is unavoidable.', ['keyboard', 'focus', 'wcag-2.4.3'])));
  const autoFocus = matches(file.text, /\bautoFocus(?:\s*=|\s|>)/g);
  pushLimited(findings, autoFocus.map(match => finding('a11y-autofocus', 'medium', 'Automatic focus requires explicit UX justification', 'Automatic focus can unexpectedly move screen-reader and keyboard users when a surface mounts.', file, match, 'Prefer deliberate focus management when a modal/dialog opens and restore focus when it closes.', ['keyboard', 'focus', 'screen-reader'])));
  for (const match of matches(file.text, /<(?:div|span)\b(?=[^>]*\bonClick\s*=)[^>]*>/gi).slice(0, 16)) {
    const hasKeyboard = /\bonKey(?:Down|Up|Press)\s*=/.test(match.excerpt); const hasRole = /\brole\s*=/.test(match.excerpt); const hasTabIndex = /\btabIndex\s*=/.test(match.excerpt);
    if (!hasKeyboard || !hasRole || !hasTabIndex) findings.push(finding('a11y-nonsemantic-click-target', 'high', 'Pointer-only non-semantic interaction candidate', 'A div/span click target does not expose the complete keyboard/role/focus contract in the opening element.', file, match, 'Use button/a when possible. Otherwise provide an appropriate role, keyboard activation, and focusability.', ['keyboard', 'semantics', 'wcag-2.1.1']));
  }
  for (const match of matches(file.text, /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi).slice(0, 12)) {
    if (!/\brel\s*=\s*["'][^"']*(?:noopener|noreferrer)/i.test(match.excerpt)) findings.push(finding('a11y-external-link-isolation', 'medium', 'New-window link lacks opener isolation contract', 'Links opening a new browsing context should declare opener isolation and should communicate the behavior in accessible copy when material.', file, match, 'Add rel="noopener noreferrer" and ensure the accessible name/context makes the new-window behavior understandable where needed.', ['navigation', 'security', 'screen-reader']));
  }
  for (const match of matches(file.text, /<img\b[^>]*>/gi).slice(0, 20)) if (!/\balt\s*=/.test(match.excerpt)) findings.push(finding('a11y-image-alt-contract', 'high', 'Image lacks an explicit alternative-text contract', 'Every img must explicitly provide meaningful alt text or alt="" when decorative.', file, match, 'Add an alt attribute. Use empty alt only for decorative imagery that conveys no information.', ['images', 'screen-reader', 'wcag-1.1.1']));
  for (const match of matches(file.text, /<button\b[^>]*>/gi).slice(0, 20)) if (!/\btype\s*=/.test(match.excerpt)) findings.push(finding('a11y-button-type-contract', 'low', 'Button relies on implicit form-submit behavior', 'A button without an explicit type can become a submit control when moved into a form, causing keyboard and validation regressions.', file, match, 'Declare type="button" for actions and type="submit" only for intentional form submission.', ['forms', 'keyboard', 'regression']));
  for (const match of matches(file.text, /<(?:input|select|textarea)\b[^>]*>/gi).slice(0, 24)) {
    if (/\b(?:aria-label|aria-labelledby)\s*=/.test(match.excerpt)) continue;
    const id = /\bid\s*=\s*["']([^"']+)["']/.exec(match.excerpt)?.[1];
    if (id && new RegExp(`<label\\b[^>]*\\bhtmlFor\\s*=\\s*["']${escapeRegex(id)}["']`, 'i').test(file.text)) continue;
    findings.push(finding('a11y-form-control-name', 'medium', 'Form control has no statically verifiable accessible name', 'The control does not expose aria-label/aria-labelledby and no matching static label htmlFor could be verified.', file, match, 'Associate a visible label through htmlFor/id, or use aria-labelledby when the visible label is composed elsewhere.', ['forms', 'screen-reader', 'wcag-3.3.2']));
  }
  return findings;
}

function auditCssFile(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of matches(file.text, /(?:outline\s*:\s*(?:none|0)\b|outline-width\s*:\s*0\b)/gi).slice(0, 16)) {
    const nearby = file.text.split(/\r?\n/).slice(Math.max(0, match.line - 3), match.line + 3).join(' ');
    if (!(/(box-shadow|outline-offset|border-color)\s*:/.test(nearby) && /:focus(?:-visible)?/.test(nearby))) findings.push(finding('a11y-focus-indicator-suppression', 'high', 'Focus indicator may be suppressed without replacement', 'Removing the browser outline without a nearby replacement can make keyboard focus invisible.', file, match, 'Use :focus-visible and provide a clearly visible replacement outline/ring with sufficient contrast.', ['keyboard', 'focus', 'wcag-2.4.7']));
  }
  const motion = matches(file.text, /\b(?:animation|transition)(?:-[a-z-]+)?\s*:/gi);
  const firstMotion = motion.at(0);
  if (firstMotion && !/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce/i.test(file.text)) findings.push(finding('a11y-reduced-motion-contract', 'medium', 'Motion styles have no file-local reduced-motion contract', `This stylesheet contains ${motion.length} animation/transition declaration(s) without a prefers-reduced-motion override.`, file, firstMotion, 'Add a prefers-reduced-motion: reduce override or document that a shared global contract disables these exact motion effects.', ['motion', 'vestibular', 'wcag-2.3.3']));
  return findings;
}
function auditHtmlFile(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of matches(file.text, /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/gi)) if (/(?:user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?(?:\D|$))/i.test(match.excerpt)) findings.push(finding('a11y-viewport-zoom-disabled', 'critical', 'Viewport configuration can disable user zoom', 'Preventing pinch/browser zoom blocks an essential low-vision accommodation.', file, match, 'Remove user-scalable=no and restrictive maximum-scale values; allow users to zoom.', ['zoom', 'low-vision', 'wcag-1.4.4'], true));
  return findings;
}
function countMatches(files: readonly SourceFile[], pattern: RegExp): number { return files.reduce((sum, file) => sum + matches(file.text, pattern).length, 0); }
function countsByRule(findings: readonly Finding[]): Readonly<Record<string, number>> { const counts: Record<string, number> = {}; for (const item of findings) counts[item.id] = (counts[item.id] ?? 0) + 1; return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en'))); }
export function auditAccessibility(inventory: RepositoryInventory): AuditSection<AccessibilityAuditSummary> {
  const started = performance.now(); const uiFiles = inventory.files.filter(isUiSource); const cssFiles = inventory.files.filter(isCss); const htmlFiles = inventory.files.filter(isHtml);
  const findings = [...uiFiles.flatMap(auditUiFile), ...cssFiles.flatMap(auditCssFile), ...htmlFiles.flatMap(auditHtmlFile)];
  return { domain: 'accessibility', title: 'Accessibility and keyboard regression audit', summary: { uiFiles: uiFiles.length, cssFiles: cssFiles.length, htmlFiles: htmlFiles.length, interactiveCandidates: countMatches(uiFiles, /<(?:button|a|input|select|textarea)\b|\bonClick\s*=/gi), imageCandidates: countMatches(uiFiles, /<img\b/gi), labelCandidates: countMatches(uiFiles, /<label\b|\baria-label(?:ledby)?\s*=/gi), motionDeclarations: countMatches(cssFiles, /\b(?:animation|transition)(?:-[a-z-]+)?\s*:/gi), reducedMotionContracts: countMatches(cssFiles, /prefers-reduced-motion\s*:\s*reduce/gi), forcedColorContracts: countMatches(cssFiles, /forced-colors\s*:\s*active/gi), findingsByRule: countsByRule(findings) }, findings, elapsedMs: performance.now() - started };
}