import { describe, expect, test } from 'vitest';
import { auditLegacyPresentationCss } from './legacyPresentationPolicy';

describe('legacy presentation policy', () => {
  test('accepts a local responsive keyboard-visible presentation slice', () => {
    const audit = auditLegacyPresentationCss(`
      .panel { max-inline-size: min(28rem, calc(100vw - 2rem)); inset-inline-start: 1rem; }
      .button { min-width: 44px; min-height: 44px; }
      .button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    `);
    expect(audit.passed).toBe(true);
    expect(audit.findings).toEqual([]);
  });

  test('flags remote stylesheet imports', () => {
    const audit = auditLegacyPresentationCss("@import url('https://fonts.example.test/font.css');");
    expect(audit.counts['remote-font']).toBe(1);
    expect(audit.findings[0]?.severity).toBe('high');
  });

  test('does not flag local imports', () => {
    expect(auditLegacyPresentationCss("@import './tokens.css';").counts['remote-font']).toBe(0);
  });

  test('flags simultaneous outline and shadow focus suppression', () => {
    const audit = auditLegacyPresentationCss('.btn:focus-visible { outline: 0; box-shadow: none; }');
    expect(audit.counts['focus-suppression']).toBe(1);
  });

  test('does not reject a deliberate visible focus outline', () => {
    const audit = auditLegacyPresentationCss('.btn:focus-visible { outline: 2px solid currentColor; box-shadow: none; }');
    expect(audit.counts['focus-suppression']).toBe(0);
  });

  test('flags hover-only disclosure candidates', () => {
    const audit = auditLegacyPresentationCss('.dropdown:hover .menu { display: block; }');
    expect(audit.counts['hover-only-disclosure']).toBe(1);
  });

  test('flags undersized interactive controls', () => {
    const audit = auditLegacyPresentationCss('.locate-button { width: 16px; height: 16px; }');
    expect(audit.counts['undersized-target']).toBe(1);
  });

  test('allows target dimensions at the accessibility floor', () => {
    const audit = auditLegacyPresentationCss('.tool-button { width: 44px; height: 44px; }');
    expect(audit.counts['undersized-target']).toBe(0);
  });

  test('flags large fixed modal widths', () => {
    const audit = auditLegacyPresentationCss('.legacy-modal { width: 750px; }');
    expect(audit.counts['fixed-panel-width']).toBe(1);
  });

  test('flags physical panel positioning', () => {
    const audit = auditLegacyPresentationCss('.query-panel { right: 20px; }');
    expect(audit.counts['physical-positioning']).toBe(1);
  });

  test('bounds findings for adversarial legacy input', () => {
    const css = Array.from({ length: 300 }, (_, index) => `.tool-${index} { width: 12px; height: 12px; }`).join('\n');
    const audit = auditLegacyPresentationCss(css);
    expect(audit.findings.length).toBeLessThanOrEqual(128);
  });

  test('bounds parsing input size', () => {
    const huge = '.safe { min-width: 44px; }'.repeat(30_000);
    const audit = auditLegacyPresentationCss(huge);
    expect(audit.findings.length).toBeLessThanOrEqual(128);
  });

  test('returns independent count objects', () => {
    const first = auditLegacyPresentationCss('.tool { width: 10px; }');
    const second = auditLegacyPresentationCss('.safe { width: 44px; }');
    expect(first.counts['undersized-target']).toBe(1);
    expect(second.counts['undersized-target']).toBe(0);
  });
});
