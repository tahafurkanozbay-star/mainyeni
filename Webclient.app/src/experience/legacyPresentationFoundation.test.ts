import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readFixture = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const foundationCss = readFixture('./legacyPresentationFoundation.css');
const modernizationCss = readFixture('./legacyPresentationModernization.css');

const expectAll = (source: string, fragments: readonly string[]) => {
  for (const fragment of fragments) expect(source).toContain(fragment);
};

describe('legacy presentation foundation', () => {
  it('uses local system typography without adding a remote font dependency', () => {
    expect(foundationCss).not.toMatch(/https?:\/\//i);
    expect(foundationCss).not.toMatch(/fonts\.(googleapis|gstatic)\.com/i);
    expectAll(foundationCss, [
      '--legacy-font-sans:',
      '"Segoe UI Variable"',
      'font-family: var(--legacy-font-sans)',
      'text-rendering: optimizeLegibility',
    ]);
  });

  it('defines readable fluid type and spacing primitives', () => {
    expectAll(foundationCss, [
      '--legacy-text-xs: clamp(',
      '--legacy-text-md: clamp(',
      '--legacy-text-xl: clamp(',
      '--legacy-leading-normal: 1.5',
      '--legacy-space-1:',
      '--legacy-space-6:',
    ]);
  });

  it('provides contrast-safe semantic surface primitives', () => {
    expectAll(foundationCss, [
      '--legacy-surface:',
      '--legacy-text:',
      '--legacy-text-muted:',
      '--legacy-border:',
      '--legacy-accent:',
      '--legacy-accent-contrast:',
      '--legacy-danger:',
      '--legacy-warning:',
      '--legacy-success:',
    ]);
  });

  it('keeps form controls readable and exposes invalid state', () => {
    expectAll(foundationCss, [
      ':where(input, select, textarea)',
      'min-block-size: var(--legacy-control-height)',
      "[aria-invalid='true']",
      'border-color: var(--legacy-danger)',
      ':disabled',
      'cursor: not-allowed',
    ]);
  });

  it('preserves minimum pointer targets for coarse input', () => {
    expectAll(foundationCss, [
      '--legacy-control-height: 44px',
      '--legacy-control-height-coarse: 48px',
      '@media (pointer: coarse)',
      'min-block-size: var(--legacy-control-height-coarse)',
    ]);
  });

  it('provides keyboard-equivalent states for hover-oriented legacy controls', () => {
    expectAll(foundationCss, [
      '.form-checkbox:focus-within',
      '.result-item-container:focus-within',
      '.context-menu-item:focus-within',
      '.dropdown-content a:focus-visible',
    ]);
  });

  it('uses logical spacing for modernized interactive surfaces', () => {
    expectAll(foundationCss, [
      'padding-inline:',
      'margin-inline-end:',
      'border-block-end:',
      'overscroll-behavior-inline:',
    ]);
  });

  it('contains long labels and result text instead of forcing horizontal overflow', () => {
    expectAll(foundationCss, [
      ':where(p, li, dd, .result-item-info)',
      'overflow-wrap: anywhere',
      '.form-checkbox > span',
      'min-inline-size: 0',
    ]);
  });

  it('stabilizes scrollable GIS panel surfaces', () => {
    expectAll(foundationCss, [
      '.common-query-window-body',
      '.results-container',
      'scrollbar-gutter: stable',
      'overscroll-behavior: contain',
    ]);
  });

  it('makes modal, dropdown and context-menu boundaries explicit', () => {
    expectAll(foundationCss, [
      '.common-query-window {',
      '.dropdown-content {',
      '.context-menu {',
      '.modal-content {',
      'border: 1px solid var(--legacy-border)',
      'box-shadow: var(--legacy-shadow-md)',
    ]);
  });

  it('supports high-contrast user preferences without remote assets', () => {
    expectAll(foundationCss, [
      '@media (prefers-contrast: more)',
      '--legacy-border: #64748b',
      '@media (forced-colors: active)',
      '--legacy-surface: Canvas',
      '--legacy-text: CanvasText',
      '--legacy-accent: LinkText',
    ]);
  });

  it('does not neutralize keyboard focus', () => {
    expect(foundationCss).not.toMatch(/:focus(?:-visible)?[^{}]*\{[^{}]*(?:outline\s*:\s*(?:0|none)|box-shadow\s*:\s*none)/is);
    expectAll(modernizationCss, [
      ':focus-visible',
      'outline: var(--legacy-focus-ring) !important',
      'outline-offset: var(--legacy-focus-offset) !important',
    ]);
  });

  it('honors reduced-motion preferences', () => {
    expectAll(foundationCss, [
      '@media (prefers-reduced-motion: reduce)',
      'scroll-behavior: auto !important',
    ]);
    expectAll(modernizationCss, [
      'transition-duration: 0.01ms !important',
      'animation-duration: 0.01ms !important',
      'animation-iteration-count: 1 !important',
    ]);
  });

  it('keeps compact layouts flexible instead of imposing a desktop row', () => {
    expectAll(foundationCss, [
      '@media (max-width: 767.98px)',
      '.horizontal-layout',
      'flex-wrap: wrap',
    ]);
  });

  it('keeps tables numerically stable and headers start-aligned', () => {
    expectAll(foundationCss, [
      'font-variant-numeric: tabular-nums',
      ':where(.table, table) th',
      'text-align: start',
      'vertical-align: middle',
    ]);
  });

  it('provides a visible development signal for images missing alt text', () => {
    expectAll(foundationCss, [
      ':where(img):not([alt])',
      'outline: 2px dashed var(--legacy-warning)',
    ]);
  });

  it('keeps busy and disabled states semantically distinguishable', () => {
    expectAll(foundationCss, [
      "[aria-busy='true']",
      'cursor: progress',
      "[aria-disabled='true']",
      'opacity: 0.6',
    ]);
  });

  it('supports printable query and modal content without map chrome', () => {
    expectAll(foundationCss, [
      '@media print',
      '.overviewMapDiv',
      'display: none !important',
      'position: static !important',
      'overflow: visible !important',
    ]);
  });

  it('wires the foundation before modernization overrides', () => {
    expect(modernizationCss.trimStart().startsWith("@import './legacyPresentationFoundation.css';")).toBe(true);
  });

  it('does not introduce animation, external URLs, or unsafe data payloads', () => {
    expect(foundationCss).not.toMatch(/https?:\/\//i);
    expect(foundationCss).not.toMatch(/url\s*\(/i);
    expect(foundationCss).not.toMatch(/data:/i);
    expect(foundationCss).not.toMatch(/@keyframes/i);
  });
});
