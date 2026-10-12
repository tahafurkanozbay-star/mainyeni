import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/Components/Widget/LayerList/LayerListWidget.css'), 'utf8');

const extractBlock = (pattern: RegExp): string => {
  const match = css.match(pattern);
  return match?.[0] ?? '';
};

const extractMediaBlock = (marker: string): string => {
  const start = css.indexOf(marker);
  if (start < 0) return '';
  const next = css.indexOf('@media ', start + marker.length);
  return css.slice(start, next < 0 ? css.length : next);
};

describe('LayerListWidget presentation contract', () => {
  it('keeps a desktop interactive target baseline at or above 40px', () => {
    const root = extractBlock(/\.layer-list-modern\s*\{[^}]+\}/u);
    expect(root).toContain('--layer-list-action-size: 40px');
    expect(root).toContain('--layer-list-row-min: 46px');
  });

  it('upgrades coarse-pointer actions to 48px targets', () => {
    const coarse = extractMediaBlock('@media (pointer: coarse)');
    expect(coarse).toContain('--layer-list-action-size: 48px');
    expect(coarse).toContain('min-block-size: 48px');
  });

  it('keeps mobile tabs at a 48px target height', () => {
    const mobile = extractMediaBlock('@media (max-width: 560px)');
    expect(mobile).toContain('.layer-list-tab');
    expect(mobile).toContain('min-block-size: 48px');
  });

  it('does not hide opacity sliders on mobile', () => {
    const mobile = extractMediaBlock('@media (max-width: 560px)');
    expect(mobile).not.toMatch(/\.layer-list-opacity[^}]*display\s*:\s*none/iu);
    expect(css).not.toMatch(/\.layer-list-opacity\s+input[^}]*display\s*:\s*none/iu);
  });

  it('keeps opacity controls touch-manipulation friendly', () => {
    const slider = extractBlock(/\.layer-list-opacity input\[type='range'\]\s*\{[^}]+\}/u);
    expect(slider).toContain('touch-action: manipulation');
    expect(slider).toContain('accent-color: var(--exp-accent)');
  });

  it('provides explicit reduced-motion handling', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('transition: none !important');
  });

  it('provides explicit forced-colors handling', () => {
    expect(css).toContain('@media (forced-colors: active)');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('CanvasText');
    expect(forced).toContain('Highlight');
    expect(forced).toContain('forced-color-adjust: auto');
  });

  it('never suppresses focus outlines', () => {
    expect(css).not.toMatch(/outline\s*:\s*(?:none|0)(?:\s|;|!)/iu);
  });

  it('provides visible focus styling for the tree', () => {
    const focus = extractBlock(/\.layer-list-tree:focus-visible\s*\{[^}]+\}/u);
    expect(focus).toContain('outline: 3px solid');
    expect(focus).toContain('outline-offset: 2px');
  });

  it('provides visible focus styling for tabs', () => {
    const focus = extractBlock(/\.layer-list-tab:focus-visible\s*\{[^}]+\}/u);
    expect(focus).toContain('outline: 3px solid');
  });

  it('provides visible focus styling for opacity sliders', () => {
    const focus = extractBlock(/\.layer-list-opacity input\[type='range'\]:focus-visible\s*\{[^}]+\}/u);
    expect(focus).toContain('outline: 3px solid');
  });

  it('uses logical properties for primary sizing and spacing', () => {
    expect(css).toContain('min-block-size');
    expect(css).toContain('min-inline-size');
    expect(css).toContain('padding-inline');
    expect(css).toContain('margin-block');
  });

  it('uses bounded scroll containers for large layer trees', () => {
    const tree = extractBlock(/\.layer-list-tree\s*\{[^}]+\}/u);
    expect(tree).toContain('max-block-size: min(54vh, 620px)');
    expect(tree).toContain('overflow: auto');
    expect(tree).toContain('overscroll-behavior: contain');
  });

  it('keeps the legend bounded and scrollable', () => {
    const legend = extractBlock(/\.legend-container\s*\{[^}]+\}/u);
    expect(legend).toContain('max-block-size: min(58vh, 640px)');
    expect(legend).toContain('overflow: auto');
  });

  it('uses the shared experience surface tokens rather than hard-coded backgrounds', () => {
    expect(css).toContain('var(--exp-surface)');
    expect(css).toContain('var(--exp-surface-2)');
    expect(css).toContain('var(--exp-border)');
    expect(css).toContain('var(--exp-text)');
    expect(css).toContain('var(--exp-accent)');
  });

  it('does not introduce remote assets or url() dependencies', () => {
    expect(css).not.toContain('http://');
    expect(css).not.toContain('https://');
    expect(css).not.toMatch(/url\s*\(/iu);
  });

  it('does not introduce animation keyframes into the data-heavy layer surface', () => {
    expect(css).not.toContain('@keyframes');
  });

  it('preserves a distinct active-row presentation', () => {
    expect(css).toContain(".layer-list-tree-row[data-active='true']");
    expect(css).toContain('inset 3px 0 0 var(--exp-accent)');
  });

  it('preserves a visual mixed-visibility mark for partially visible groups', () => {
    expect(css).toContain(".kr-layer-visibility-mark[data-mixed='true']::after");
  });

  it('keeps keyboard help visually compact and separate from live status', () => {
    const help = extractBlock(/\.layer-list-keyboard-help\s*\{[^}]+\}/u);
    expect(help).toContain('flex-wrap: wrap');
    expect(help).toContain('font-size: 0.68rem');
  });

  it('hides keyboard legend copy on narrow phones without removing keyboard semantics from DOM logic', () => {
    const mobile = extractBlock(/@media \(max-width: 560px\)\s*\{[\s\S]*?\n\}/u);
    expect(mobile).toContain('.layer-list-keyboard-help');
    expect(mobile).toContain('display: none');
  });

  it('keeps status surfaces visually differentiated for busy and danger states', () => {
    expect(css).toContain(".layer-list-status[data-tone='busy']");
    expect(css).toContain(".layer-list-status[data-tone='danger']");
  });

  it('keeps tab panels removable through the semantic hidden attribute', () => {
    const hidden = extractBlock(/\.layer-list-panel\[hidden\]\s*\{[^}]+\}/u);
    expect(hidden).toContain('display: none !important');
  });

  it('uses no Bootstrap-specific accordion or nav-tab selectors', () => {
    expect(css).not.toContain('.accordion');
    expect(css).not.toContain('.nav-tabs');
    expect(css).not.toContain('.nav-link');
  });
});
