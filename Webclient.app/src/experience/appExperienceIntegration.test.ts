import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

const expectImport = (modulePath: string): void => {
  expect(appSource).toContain(`from '${modulePath}'`);
};

const expectRendered = (componentName: string): void => {
  expect(appSource).toContain(`<${componentName}`);
};

const indexOfRendered = (componentName: string): number => {
  const index = appSource.indexOf(`<${componentName}`);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
};

describe('App Experience integration contract', () => {
  test('loads the legacy modernization layer after canonical Experience styles', () => {
    const canonicalStyles = appSource.indexOf("import './Components/Common/experience-data-ux.css';");
    const modernizationStyles = appSource.indexOf("import './experience/legacyPresentationModernization.css';");

    expect(canonicalStyles).toBeGreaterThanOrEqual(0);
    expect(modernizationStyles).toBeGreaterThan(canonicalStyles);
  });

  test('imports every recovered accessibility surface from its canonical module', () => {
    expectImport('./Components/Common/ExperienceDataDisclaimer');
    expectImport('./Components/Common/ExperienceMapInteractionGuide');
    expectImport('./Components/Common/ExperiencePresentationBridge');
    expectImport('./Components/Common/ExperienceSkipNavigation');
  });

  test('mounts the presentation bridge inside the theme provider', () => {
    expectRendered('ExperienceThemeProvider');
    expectRendered('ExperiencePresentationBridge');
    expectRendered('ExperienceRuntimeBridge');

    expect(indexOfRendered('ExperiencePresentationBridge'))
      .toBeGreaterThan(indexOfRendered('ExperienceThemeProvider'));
    expect(indexOfRendered('ExperiencePresentationBridge'))
      .toBeLessThan(indexOfRendered('ExperienceRuntimeBridge'));
  });

  test('places skip navigation before the interactive map surface', () => {
    expectRendered('ExperienceSkipNavigation');
    expectRendered('MapComponent');

    expect(indexOfRendered('ExperienceSkipNavigation'))
      .toBeLessThan(indexOfRendered('MapComponent'));
  });

  test('places map interaction guidance directly after the map surface', () => {
    expectRendered('MapComponent');
    expectRendered('ExperienceMapInteractionGuide');
    expectRendered('ExperienceWorkspace');

    expect(indexOfRendered('ExperienceMapInteractionGuide'))
      .toBeGreaterThan(indexOfRendered('MapComponent'));
    expect(indexOfRendered('ExperienceMapInteractionGuide'))
      .toBeLessThan(indexOfRendered('ExperienceWorkspace'));
  });

  test('uses the shared disclaimer instead of a duplicate inline disclaimer', () => {
    expectRendered('ExperienceDataDisclaimer');
    expect(appSource).not.toContain('const SiteDataDisclaimer');
    expect(appSource).not.toContain('<SiteDataDisclaimer');
  });

  test('keeps recovered surfaces inside the startup boundary', () => {
    const boundaryStart = indexOfRendered('ExperienceStartupBoundary');
    const map = indexOfRendered('MapComponent');
    const guide = indexOfRendered('ExperienceMapInteractionGuide');
    const workspace = indexOfRendered('ExperienceWorkspace');
    const disclaimer = indexOfRendered('ExperienceDataDisclaimer');
    const boundaryEnd = appSource.indexOf('</ExperienceStartupBoundary>');

    expect(boundaryEnd).toBeGreaterThan(boundaryStart);
    for (const child of [map, guide, workspace, disclaimer]) {
      expect(child).toBeGreaterThan(boundaryStart);
      expect(child).toBeLessThan(boundaryEnd);
    }
  });

  test('preserves the existing GIS and runtime composition points', () => {
    expectRendered('ExperienceRuntimeBridge');
    expectRendered('MapComponent');
    expectRendered('ExperienceWorkspace');
    expectRendered('ExperienceUXLayer');
    expectRendered('ExperienceCommandCenter');
    expectRendered('ExperienceConnectivityNotice');
  });
});
