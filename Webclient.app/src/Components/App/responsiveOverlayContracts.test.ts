import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const ruleBlock = (sheet: string, marker: string, nextMarker: string): string => {
  const normalizedSheet = sheet.replaceAll('\r\n', '\n');
  const start = normalizedSheet.indexOf(marker);
  const end = normalizedSheet.indexOf(nextMarker, start + marker.length);
  if (start < 0 || end < 0) throw new Error('Missing responsive UI stylesheet section.');
  return normalizedSheet.slice(start, end);
};

const zIndexFor = (sheet: string, selector: string): number => {
  const start = sheet.indexOf(selector);
  const end = sheet.indexOf('}', start + selector.length);
  if (start < 0 || end < 0) throw new Error(`Missing CSS rule: ${selector}`);
  const match = sheet.slice(start, end).match(/z-index:\s*(\d+)\s*;/u);
  if (!match?.[1]) throw new Error(`Missing numeric z-index: ${selector}`);
  return Number(match[1]);
};

describe('map tool, bottom dock and fixed panel collision contracts', () => {
  it('docks the vertical toolbar beneath the header, not over the bottom navigation, on phones', () => {
    const toolbar = css('../Widget/Toolbar/ToolbarWidget.css');
    const compact = ruleBlock(toolbar, '@media (max-width: 719px) {', '@media (max-width: 520px) {');
    expect(compact).toContain('top: calc(var(--mainbar-height)');
    expect(compact).toContain('bottom: auto;');
    expect(compact).toContain('max-height: max(48px, min(48dvh,');
    expect(compact).toContain('14rem - env(safe-area-inset-bottom)');
    const premium = css('../../experience-premium.css');
    expect(premium).toContain('.toolbarwidget { top: 66px; right: 10px; bottom: auto;');
    expect(premium).toContain('14rem - env(safe-area-inset-bottom)');
    expect(premium).not.toContain('.toolbarwidget { top: auto;');
    const phone = ruleBlock(toolbar, '@media (max-width: 520px) {', '@media (pointer: coarse) {');
    expect(phone).not.toMatch(/bottom:\s*max\(/u);
    expect(phone).not.toMatch(/top:\s*auto/u);
  });

  it('does not let compact expanded service panels sit underneath the floating bottom dock', () => {
    const sidebar = css('./SidebarModern.css');
    const shell = css('./MapWorkspaceShellOverlay.css');
    const premium = css('../../experience-premium.css');
    expect(sidebar).toContain('max-width: 100dvw;');
    expect(premium).toContain('height: calc(100dvh - 68px);');
    expect(premium).toContain('height: calc(100dvh - 62px);');
    expect(premium).toContain('height: calc(100dvh - 58px);');
    expect(premium).toContain('.sidebar-container.kr-sidebar.is-collapsed { width: 72px; }');
    const tabletRail = ruleBlock(shell, '@media (max-width: 880px) and (min-width: 720px) {', '@media (max-width: 880px) {');
    expect(tabletRail).toContain('--kr-premium-sidebar-width: 82px;');

    const constrained = ruleBlock(shell, '@media (max-width: 880px) {', '@media (max-width: 719px) {');
    expect(constrained).not.toContain('--kr-premium-sidebar-width: 82px;');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .map-workspace-shell-overlay');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .experience-workspace');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .experience-utility');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .common-query-window');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .kr-lazy-window');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .esri-popup');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar.is-collapsed) .common-query-window');
    expect(constrained).toContain('left: calc(var(--kr-premium-sidebar-width, 82px) + 12px);');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar.is-collapsed):has(.common-query-window[style*="visibility: visible"]) .toolbarwidget');
    expect(constrained).toContain('#app-shell:has(.kr-sidebar.is-collapsed):has(.common-query-window[style*="visibility: visible"]) .esri-popup');
    expect(constrained).toContain('visibility: hidden !important;');
    expect(constrained).toContain('pointer-events: none;');

    const compact = ruleBlock(shell, '@media (max-width: 719px) {', '@media (max-width: 420px) {');
    expect(compact).toContain('inset-block-end: calc(5rem + env(safe-area-inset-bottom));');
  });

  it('keeps a visible keyboard focus indicator on sidebar search inputs', () => {
    const sidebar = css('./SidebarModern.css');
    const normal = ruleBlock(sidebar, '.kr-sidebar__search input {', '.kr-sidebar__search input:focus-visible {');
    expect(normal).not.toMatch(/outline\s*:\s*(?:0|none)\s*;/u);
    const focus = ruleBlock(sidebar, '.kr-sidebar__search input:focus-visible {', '.kr-sidebar__search input::placeholder {');
    expect(focus).toMatch(/outline:\s*2px solid/u);
    expect(focus).toContain('outline-offset: -2px;');
  });

  it('keeps query minimize/close buttons visible when a title is long', () => {
    const tools = css('../Query/_Common/CommonQueryWindowTools.css');
    const minimize = ruleBlock(
      tools,
      '.common-query-window-tool-minimise-button {',
      '.common-query-window-tool-close-button {',
    );
    expect(minimize).toContain('display: block;');
    expect(minimize).toContain('inline-size: 1.35rem;');
    expect(minimize).not.toContain('display: none;');

    const premium = css('../../experience-premium.css');
    const title = ruleBlock(
      premium,
      '.common-query-window-header > span {',
      '.common-query-window-header-icon {',
    );
    expect(title).toContain('flex: 1 1 auto;');
    expect(title).toContain('min-width: 0;');
    expect(title).toContain('overflow-wrap: anywhere;');
  });

  it('keeps long modal and service titles readable while retaining independent close/favorite buttons', () => {
    const overlays = css('../Common/experience-overlay-stack.css');
    const sidebar = css('./SidebarModern.css');
    const modal = ruleBlock(overlays, '.experience-overlay-surface__title {', '.experience-overlay-surface__close {');
    expect(modal).toContain('white-space: normal;');
    expect(modal).toContain('overflow-wrap: anywhere;');
    expect(modal).toContain('max-block-size: min(5.5rem, 25dvh);');
    expect(modal).not.toContain('text-overflow: ellipsis;');
    const favorites = ruleBlock(sidebar, '.kr-sidebar__item-copy {', '.kr-sidebar__item-copy small {');
    expect(favorites).toContain('white-space: normal;');
    expect(favorites).toContain('overflow-wrap: anywhere;');
    expect(sidebar).toContain('padding-right: 49px;');
    expect(sidebar).toContain('.kr-sidebar__favorite {');
  });

  it('keeps the notification triage modal above map controls while preserving settings priority', () => {
    const triage = css('../Common/experience-notification-triage-modal.css');
    const overlays = css('../Common/experience-overlay-stack.css');
    const workspace = css('../Common/experience-workspace.css');
    const notifications = css('../Common/experience-notification-center.css');
    const toolbar = css('../Widget/Toolbar/ToolbarWidget.css');

    const modalZ = zIndexFor(
      triage,
      ".experience-notification-triage[data-modal='true'][data-expanded='true'] {",
    );
    expect(modalZ).toBe(1250);
    expect(modalZ).toBeGreaterThan(zIndexFor(overlays, '.experience-overlay-stack {'));
    expect(modalZ).toBeGreaterThan(zIndexFor(workspace, '.experience-workspace {'));
    expect(modalZ).toBeGreaterThan(zIndexFor(notifications, '.experience-notifications--toasts {'));
    expect(modalZ).toBeGreaterThan(zIndexFor(toolbar, '.toolbarwidget {'));
    expect(modalZ).toBeLessThan(zIndexFor(workspace, '.experience-settings-backdrop {'));
  });
});
