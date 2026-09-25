import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { stripLegacyRemotePresentationImports } from '../../tooling/sourceTransforms.ts';
import {
  evaluateLegacyPresentationRemediation,
  legacyPresentationRemediationChecklist,
} from './legacyPresentationRemediation';

const readFixture = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const foundationCss = readFixture('./legacyPresentationFoundation.css');
const modernizationCss = readFixture('./legacyPresentationModernization.css');
const legacyCss = readFixture('../styles.css');
const effectiveLegacyCss = stripLegacyRemotePresentationImports(legacyCss);

const minimalFoundation = `
:root {
  --legacy-font-sans: system-ui, sans-serif;
  --legacy-control-height: 44px;
  --legacy-control-height-coarse: 48px;
}
html { font-family: var(--legacy-font-sans); }
`;

const minimalModernization = `
:root {
  --legacy-focus-ring: 2px solid currentColor;
  --legacy-focus-offset: 3px;
  --legacy-target-min: 44px;
  --legacy-target-coarse: 48px;
}
:where(button):focus-visible {
  outline: var(--legacy-focus-ring) !important;
  outline-offset: var(--legacy-focus-offset) !important;
}
.btn:focus-visible {
  outline: var(--legacy-focus-ring) !important;
}
.dropdown:focus-within .dropdown-content { display: block; }
.dropdown-content a:focus-visible { background: white; }
#locateButtonContainer { min-inline-size: var(--legacy-target-min); }
.common-query-window {
  inline-size: min(34rem, calc(100dvw - 2rem));
  max-inline-size: var(--legacy-panel-max);
  inset-inline-start: 1rem;
  inset-inline-end: auto;
  inset-block-start: 1rem;
  inset-block-end: auto;
}
.ZoningStatusDocument_ModalContainer .modal-dialog {
  inline-size: min(750px, calc(100dvw - 2rem));
}
@media (pointer: coarse) {
  #locateButtonContainer { min-inline-size: var(--legacy-target-coarse); }
}
@media (max-width: 767.98px) {
  .common-query-window { min-inline-size: 0; }
}
`;

const remoteFontUrl = ['https://fonts', '.googleapis.com/css?family=Mukta'].join('');
const riskyLegacy = `
@import url('${remoteFontUrl}');
.btn:focus-visible { outline: 0; box-shadow: none; }
.dropdown:hover .dropdown-content { display: block; }
#locateButtonContainer { width: 16px; height: 16px; }
.common-query-window { width: 500px; left: 70px; }
`;

const cleanEffectiveLegacy = stripLegacyRemotePresentationImports(riskyLegacy);

describe('legacyPresentationRemediation', () => {
  test('proves the active repository legacy presentation risks are covered', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss, effectiveLegacyCss, foundationCss, modernizationCss });
    expect(report.passed).toBe(true);
    expect(report.findingCount).toBeGreaterThan(0);
    expect(report.unresolvedFindingCount).toBe(0);
    expect(report.remediatedFindingCount).toBe(report.findingCount);
    expect(report.coveragePercent).toBe(100);
    expect(report.risks['remote-font'].findingCount).toBeGreaterThan(0);
    expect(report.risks['focus-suppression'].findingCount).toBeGreaterThan(0);
    expect(report.risks['undersized-target'].findingCount).toBeGreaterThan(0);
  });

  test('treats build-time remote font cleanup plus local typography as remediation', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization });
    expect(report.risks['remote-font']).toMatchObject({ status: 'remediated', findingCount: 1, missing: [] });
    expect(report.risks['remote-font'].evidence.length).toBeGreaterThanOrEqual(4);
  });

  test('fails closed if the effective build still includes a remote stylesheet', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: riskyLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization });
    expect(report.passed).toBe(false);
    expect(report.risks['remote-font'].status).toBe('unresolved');
    expect(report.risks['remote-font'].missing.join(' ')).toContain('forbidden:');
    expect(report.unresolvedFindingCount).toBeGreaterThan(0);
  });

  test('fails closed if local system typography is not defined', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: ':root {}', modernizationCss: minimalModernization });
    expect(report.risks['remote-font'].status).toBe('unresolved');
    expect(report.risks['remote-font'].missing.length).toBe(2);
  });

  test('requires a visible important focus ring to override legacy suppression', () => {
    const modernizationWithoutFocus = minimalModernization.replace(/:where\(button\):focus-visible[\s\S]*?\}\n/, '').replace(/\.btn:focus-visible[\s\S]*?\}\n/, '');
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: modernizationWithoutFocus });
    expect(report.risks['focus-suppression'].status).toBe('unresolved');
    expect(report.risks['focus-suppression'].missing.length).toBeGreaterThan(0);
  });

  test('requires keyboard-equivalent dropdown disclosure', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization.replace('.dropdown:focus-within .dropdown-content { display: block; }', '') });
    expect(report.risks['hover-only-disclosure'].status).toBe('unresolved');
    expect(report.risks['hover-only-disclosure'].findingCount).toBeGreaterThan(0);
  });

  test('requires both default and coarse-pointer target budgets', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation.replace('--legacy-control-height-coarse: 48px;', ''), modernizationCss: minimalModernization.replace('--legacy-target-coarse: 48px;', '') });
    expect(report.risks['undersized-target'].status).toBe('unresolved');
    expect(report.risks['undersized-target'].missing.length).toBeGreaterThanOrEqual(2);
  });

  test('requires viewport-bounded logical query-window sizing', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization.replace('inline-size: min(34rem, calc(100dvw - 2rem));', 'width: 500px;').replace('max-inline-size: var(--legacy-panel-max);', '') });
    expect(report.risks['fixed-panel-width'].status).toBe('unresolved');
  });

  test('requires logical positioning evidence for legacy floating panels', () => {
    const report = evaluateLegacyPresentationRemediation({ legacyCss: riskyLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization.replace(/inset-inline-start:[^;]+;/g, '').replace(/inset-inline-end:[^;]+;/g, '').replace(/inset-block-start:[^;]+;/g, '').replace(/inset-block-end:[^;]+;/g, '') });
    expect(report.risks['physical-positioning'].status).toBe('unresolved');
  });

  test('does not count an unresolved remediation when the matching risk is absent', () => {
    const cleanLegacy = '.plain { color: black; }';
    const report = evaluateLegacyPresentationRemediation({ legacyCss: cleanLegacy, effectiveLegacyCss: cleanLegacy, foundationCss: minimalFoundation, modernizationCss: '' });
    expect(report.findingCount).toBe(0);
    expect(report.unresolvedFindingCount).toBe(0);
    expect(report.coveragePercent).toBe(100);
    expect(report.passed).toBe(false);
  });

  test('bounds oversized source input before auditing it', () => {
    const oversizedLegacy = `${' '.repeat(800_000)}${riskyLegacy}`;
    const report = evaluateLegacyPresentationRemediation({ legacyCss: oversizedLegacy, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization });
    expect(report.findingCount).toBe(0);
    expect(report.coveragePercent).toBe(100);
    expect(report.passed).toBe(true);
  });

  test('returns a deterministic remediation checklist for release evidence', () => {
    const checklist = legacyPresentationRemediationChecklist();
    expect(checklist.length).toBeGreaterThanOrEqual(12);
    expect(checklist[0]).toContain('remote-font:');
    expect(checklist.some((entry) => entry.includes('focus-suppression:'))).toBe(true);
    expect(checklist.some((entry) => entry.includes('fixed-panel-width:'))).toBe(true);
    expect(new Set(checklist).size).toBe(checklist.length);
  });

  test('never exposes unbounded legacy CSS in remediation evidence', () => {
    const secretMarker = 'sensitive-marker-that-must-not-be-copied-in-full';
    const report = evaluateLegacyPresentationRemediation({ legacyCss: `${riskyLegacy}\n.bad { left: 1px; content: '${secretMarker.repeat(20)}'; }`, effectiveLegacyCss: cleanEffectiveLegacy, foundationCss: minimalFoundation, modernizationCss: minimalModernization });
    const serialized = JSON.stringify(report);
    expect(serialized.length).toBeLessThan(12_000);
    expect(serialized).not.toContain(secretMarker.repeat(4));
  });
});
