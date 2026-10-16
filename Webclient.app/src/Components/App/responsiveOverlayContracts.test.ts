import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const ruleBlock = (sheet: string, marker: string, nextMarker: string): string => {
  const start = sheet.indexOf(marker);
  const end = sheet.indexOf(nextMarker, start + marker.length);
  if (start < 0 || end < 0) throw new Error('Missing responsive UI stylesheet section.');
  return sheet.slice(start, end);
};

describe('map tool, bottom dock and fixed panel collision contracts', () => {
  it('docks the vertical toolbar beneath the header, not over the bottom navigation, on phones', () => {
    const toolbar = css('../Widget/Toolbar/ToolbarWidget.css');
    const compact = ruleBlock(toolbar, '@media (max-width: 719px) {', '@media (max-width: 520px) {');
    expect(compact).toContain('top: calc(var(--mainbar-height)');
    expect(compact).toContain('bottom: auto;');
    expect(compact).toContain('max-height: max(48px, min(48dvh,');
    expect(compact).toContain('12rem - env(safe-area-inset-bottom)');
    const phone = ruleBlock(toolbar, '@media (max-width: 520px) {', '@media (pointer: coarse) {');
    expect(phone).not.toMatch(/bottom:\s*max\(/u);
    expect(phone).not.toMatch(/top:\s*auto/u);
  });

  it('does not let compact expanded service panels sit underneath the floating bottom dock', () => {
    const sidebar = css('./SidebarModern.css');
    const shell = css('./MapWorkspaceShellOverlay.css');
    expect(sidebar).toContain('width: min(var(--sidebar-hover-width, 470px), 100dvw);');
    expect(sidebar).toContain('height: calc(100dvh - var(--mainbar-height, 64px));');
    const compact = ruleBlock(shell, '@media (max-width: 719px) {', '@media (max-width: 420px) {');
    expect(compact).toContain('#app-shell:has(.kr-sidebar:not(.is-collapsed)) .map-workspace-shell-overlay');
    expect(compact).toContain('visibility: hidden;');
    expect(compact).toContain('pointer-events: none;');
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
});
