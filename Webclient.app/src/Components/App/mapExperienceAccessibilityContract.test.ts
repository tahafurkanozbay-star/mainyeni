import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webclientRoot = process.cwd().endsWith('Webclient.app') ? process.cwd() : resolve(process.cwd(), 'Webclient.app');
const read = (name: string): string => readFileSync(resolve(webclientRoot, 'src', 'Components', 'App', name), 'utf8');

const modeCss = read('MapModeExperienceControl.css');
const recoveryCss = read('MapWorkspaceRecoverySurface.css');
const modeComponent = read('MapModeExperienceControl.tsx');
const recoveryComponent = read('MapWorkspaceRecoverySurface.tsx');
const modeModel = read('mapModeExperienceModel.ts');
const recoveryModel = read('mapWorkspaceRecoveryModel.ts');
const focusModel = read('mapModeFocusModel.ts');
const mapComponent = read('MapComponent.tsx');
const toolbarComponent = readFileSync(
  resolve(webclientRoot, 'src', 'Components', 'Widget', 'Toolbar', 'ToolbarWidgetModern.tsx'),
  'utf8',
);
const application = readFileSync(resolve(webclientRoot, 'src', 'App.tsx'), 'utf8');

const NEW_EXPERIENCE_SOURCES = [
  modeCss,
  recoveryCss,
  modeComponent,
  recoveryComponent,
  modeModel,
  recoveryModel,
  focusModel,
];

describe('map experience accessibility and network contracts', () => {
  it('keeps the default mode target at least 44px and coarse targets at 48px', () => {
    expect(modeCss).toMatch(/\.map-mode-experience__mode\s*\{[\s\S]*?min-block-size:\s*44px;/u);
    expect(modeCss).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*?min-block-size:\s*48px;/u);
    expect(recoveryCss).toMatch(/\.map-workspace-recovery__retry\{[^}]*min-block-size:44px;/u);
    expect(recoveryCss).toMatch(/@media\(pointer:coarse\)[\s\S]*?min-block-size:48px/u);
  });

  it('keeps visible focus rings for every new interactive control', () => {
    expect(modeCss).toContain('.map-mode-experience__mode:focus-visible');
    expect(modeCss).toContain('.map-mode-experience__retry:focus-visible');
    expect(recoveryCss).toContain('.map-workspace-recovery__retry:focus-visible');
  });

  it('does not suppress focus outlines in the new presentation layer', () => {
    const combined = `${modeCss}\n${recoveryCss}`;
    expect(combined).not.toMatch(/outline\s*:\s*(?:0|none)\b/iu);
  });

  it('contains explicit reduced-motion presentation fallbacks', () => {
    expect(modeCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(modeCss).toContain("html[data-experience-motion='reduced']");
    expect(recoveryCss).toContain('@media(prefers-reduced-motion:reduce)');
    expect(modeCss).toMatch(/animation:\s*none/u);
    expect(recoveryCss).toMatch(/animation:none/u);
  });

  it('contains forced-colors fallbacks without disabling system colors', () => {
    expect(modeCss).toContain('@media (forced-colors: active)');
    expect(recoveryCss).toContain('@media(forced-colors:active)');
    expect(modeCss).toContain('forced-color-adjust: auto');
    expect(recoveryCss).toContain('forced-color-adjust:auto');
    expect(modeCss).toContain('outline-color: Highlight');
    expect(recoveryCss).toContain('outline-color:Highlight');
  });

  it('uses native button semantics for mode selection and recovery', () => {
    expect(modeComponent).toMatch(/<button[\s\S]*?type="button"[\s\S]*?role="radio"/u);
    expect(modeComponent).toContain('role="radiogroup"');
    expect(recoveryComponent).toMatch(/<button[\s\S]*?type="button"[\s\S]*?Haritayı yeniden başlat/u);
  });

  it('exposes deterministic accessible names for both map modes', () => {
    expect(modeComponent).toContain('aria-label="2B harita görünümüne geç"');
    expect(modeComponent).toContain('aria-label="3B sahne görünümüne geç"');
  });

  it('keeps exactly one roving tab-stop authority wired into the mode component', () => {
    expect(modeComponent).toContain('tabIndex={focusSnapshot.tabIndex2D}');
    expect(modeComponent).toContain('tabIndex={focusSnapshot.tabIndex3D}');
    expect(modeComponent).toContain('focusModel.move(move)');
    expect(modeComponent).toContain('focusModel.sync(snapshot.currentMode');
  });

  it('keeps Arrow, Home and End keyboard navigation in the mode radiogroup', () => {
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) {
      expect(modeComponent).toContain(`event.key === '${key}'`);
    }
  });

  it('keeps the active radio checked while another mode is pending', () => {
    expect(modeComponent).toContain("aria-checked={snapshot.currentMode === '2d'}");
    expect(modeComponent).toContain("aria-checked={snapshot.currentMode === '3d'}");
    expect(modeComponent).not.toContain("aria-checked={snapshot.currentMode === '2d' &&");
  });

  it('uses assertive live regions only for error states', () => {
    expect(modeComponent).toContain('aria-live={presentation.livePoliteness}');
    expect(recoveryComponent).toContain("aria-live={isError ? 'assertive' : 'polite'}");
    expect(recoveryComponent).toContain("role={isError ? 'alert' : 'status'}");
  });

  it('keeps transition and recovery stores on useSyncExternalStore', () => {
    expect(modeComponent).toContain('useSyncExternalStore(model.subscribe');
    expect(modeComponent).toContain('useSyncExternalStore(focusModel.subscribe');
    expect(recoveryComponent).toContain('useSyncExternalStore(model.subscribe');
  });

  it('keeps every new model observer failure path non-empty and diagnosable', () => {
    for (const source of [modeModel, recoveryModel, focusModel]) {
      expect(source).toContain('observerFailureCount');
      expect(source).toContain('reporterFailureCount');
      expect(source).not.toMatch(/catch\s*\{\s*\}/gu);
    }
  });

  it('keeps observer cardinality explicitly bounded', () => {
    expect(modeModel).toContain('DEFAULT_MAX_OBSERVERS = 32');
    expect(modeModel).toContain('MAX_OBSERVERS_LIMIT = 96');
    expect(recoveryModel).toContain('DEFAULT_MAX_OBSERVERS = 24');
    expect(recoveryModel).toContain('MAX_OBSERVERS_LIMIT = 64');
    expect(focusModel).toContain('DEFAULT_MAX_OBSERVERS = 16');
    expect(focusModel).toContain('MAX_OBSERVERS_LIMIT = 48');
  });

  it('keeps mode and recovery retry budgets explicitly bounded', () => {
    expect(modeModel).toContain('DEFAULT_MAX_ATTEMPTS = 3');
    expect(modeModel).toContain('MAX_ATTEMPTS_LIMIT = 5');
    expect(recoveryModel).toContain('DEFAULT_MAX_ATTEMPTS = 3');
    expect(recoveryModel).toContain('MAX_ATTEMPTS_LIMIT = 5');
  });

  it('does not retain raw map bootstrap error messages in the recovery model', () => {
    expect(recoveryModel).not.toContain('error.message.slice');
    expect(recoveryModel).not.toContain('error.message.trim');
    expect(recoveryModel).toContain('genericErrorMessage(kind)');
    expect(recoveryModel).toContain('sanitizeDiagnosticCode');
  });

  it('does not add browser network carriers to the new Experience sources', () => {
    for (const source of NEW_EXPERIENCE_SOURCES) {
      expect(source).not.toMatch(/\bfetch\s*\(/u);
      expect(source).not.toMatch(/\bXMLHttpRequest\b/u);
      expect(source).not.toMatch(/\bWebSocket\b/u);
      expect(source).not.toMatch(/sendBeacon\s*\(/u);
    }
  });

  it('does not add remote font, CDN, analytics or tracking URLs', () => {
    const combined = NEW_EXPERIENCE_SOURCES.join('\n');
    expect(combined).not.toMatch(/https?:\/\//iu);
    expect(combined).not.toMatch(/@import\s+url/iu);
    expect(combined).not.toMatch(/google-analytics|gtag\s*\(|segment\.com|mixpanel/iu);
  });

  it('does not introduce WMS or WFS UI or transport strings', () => {
    const combined = NEW_EXPERIENCE_SOURCES.join('\n');
    expect(combined).not.toMatch(/\bWMS\b|\bWFS\b/u);
  });

  it('does not create a second icon resolver or remote icon path', () => {
    const combined = NEW_EXPERIENCE_SOURCES.join('\n');
    expect(combined).not.toMatch(/resolveIcon|iconResolver|iconRegistry/iu);
    for (const tag of ['<' + 'img', '<' + 'svg']) {
      expect(combined).not.toContain(tag);
    }
  });

  it('keeps one governed mode control in the shared workspace', () => {
    expect(application).toContain('<ExperienceWorkspace externalMapModeControl />');
    expect(application).not.toContain('ExperienceMapModeGovernedOverlay');
    expect(mapComponent).toContain('<ModernToolbarWidget');
    expect(toolbarComponent).toContain('<MapModeExperienceControl');
  });

  it('keeps the recovery surface mounted before map-view-dependent widgets', () => {
    const recoveryIndex = mapComponent.indexOf('<MapWorkspaceRecoverySurface');
    const viewIndex = mapComponent.indexOf('{mapView && <>');
    expect(recoveryIndex).toBeGreaterThan(0);
    expect(viewIndex).toBeGreaterThan(recoveryIndex);
  });

  it('keeps retries on generation-based cleanup instead of page reload', () => {
    expect(mapComponent).toContain('setMapGeneration((generation) => generation + 1)');
    expect(mapComponent).not.toMatch(/location\.reload\s*\(/u);
    expect(mapComponent).not.toMatch(/window\.location\s*=/u);
  });

  it('keeps recovery success and failure tied to the exact attempt id', () => {
    expect(mapComponent).toContain('recoveryModel.succeed(recoveryAttemptId)');
    expect(mapComponent).toContain('recoveryModel.fail(recoveryAttemptId, error)');
  });

  it('keeps ArcGIS runtime ownership unchanged', () => {
    expect(mapComponent).toContain('loadArcgisModules');
    expect(mapComponent).toContain('<ExperienceMapModeBridge');
    expect(modeComponent).toContain("name: 'map-mode'");
    expect(modeComponent).toContain('EXPERIENCE_MAP_MODE_EVENT');
  });

  it('keeps presentation facts explicit for regression inspection', () => {
    expect(modeComponent).toContain('data-layout={presentation.layout}');
    expect(modeComponent).toContain('data-target-size={presentation.targetSizePx}');
    expect(modeComponent).toContain('data-transition-speed={presentation.transitionSpeed}');
    expect(modeComponent).toContain('data-interaction-state={presentation.interactionState}');
  });
});
