import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

const modeCss = read('MapModeExperienceControl.css');
const recoveryCss = read('MapWorkspaceRecoverySurface.css');
const mapCss = read('MapComponent.css');
const mapComponent = read('MapComponent.tsx');

const mobileModeBlock = (): string => {
  const mediaStart = modeCss.indexOf('@media (max-width: 45rem)');
  expect(mediaStart).toBeGreaterThanOrEqual(0);
  const nextMedia = modeCss.indexOf('@media (pointer: coarse)', mediaStart);
  expect(nextMedia).toBeGreaterThan(mediaStart);
  return modeCss.slice(mediaStart, nextMedia);
};

describe('map experience layout collision contract', () => {
  it('anchors the compact mode switcher below the top safe area instead of the 3B bottom controls', () => {
    const mobile = mobileModeBlock();

    expect(mobile).toContain('top: max(76px, calc(env(safe-area-inset-top) + 70px))');
    expect(mobile).toContain('bottom: auto');
    expect(mobile).not.toContain('bottom: max(12px');
  });

  it('keeps the compact mode switcher inside the right safe area', () => {
    const mobile = mobileModeBlock();

    expect(mobile).toContain('right: max(10px, env(safe-area-inset-right))');
    expect(mobile).toContain('inline-size: min(252px, calc(100vw - 20px))');
  });

  it('keeps the existing 3B camera controls bottom-anchored on compact screens', () => {
    expect(mapCss).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.experience-scene-controls\s*\{[\s\S]*?bottom:\s*max\(56px,/u,
    );
  });

  it('keeps the existing 3B health badge below the camera-control row', () => {
    expect(mapCss).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.experience-scene-health\s*\{[\s\S]*?bottom:\s*max\(12px,/u,
    );
  });

  it('keeps the mode switcher above the scene camera and health z-index layers', () => {
    expect(modeCss).toMatch(/\.map-mode-experience\s*\{[\s\S]*?z-index:\s*21;/u);
    expect(mapCss).toMatch(/\.experience-scene-controls\s*\{[\s\S]*?z-index:\s*19;/u);
    expect(mapCss).toMatch(/\.experience-scene-health\s*\{[\s\S]*?z-index:\s*18;/u);
  });

  it('keeps recovery above normal map mode controls while bootstrap is unhealthy', () => {
    expect(recoveryCss).toMatch(/\.map-workspace-recovery\{[^}]*z-index:24;/u);
    expect(modeCss).toMatch(/\.map-mode-experience\s*\{[\s\S]*?z-index:\s*21;/u);
  });

  it('mounts recovery before the map-view-dependent interaction shell', () => {
    const recoveryIndex = mapComponent.indexOf('<MapWorkspaceRecoverySurface');
    const dependentIndex = mapComponent.indexOf('{mapView && <>');

    expect(recoveryIndex).toBeGreaterThan(0);
    expect(dependentIndex).toBeGreaterThan(recoveryIndex);
  });

  it('mounts the 2B/3B mode switcher only after a map view exists', () => {
    const dependentIndex = mapComponent.indexOf('{mapView && <>');
    const modeIndex = mapComponent.indexOf('<MapModeExperienceControl />');

    expect(dependentIndex).toBeGreaterThan(0);
    expect(modeIndex).toBeGreaterThan(dependentIndex);
  });

  it('keeps the actual ArcGIS 2B/3B bridge adjacent to the governed mode control', () => {
    const modeIndex = mapComponent.indexOf('<MapModeExperienceControl />');
    const bridgeIndex = mapComponent.indexOf('<ExperienceMapModeBridge');

    expect(modeIndex).toBeGreaterThan(0);
    expect(bridgeIndex).toBeGreaterThan(modeIndex);
    expect(bridgeIndex - modeIndex).toBeLessThan(300);
  });

  it('does not move recovery into the scene-only control layer', () => {
    const recoveryIndex = mapComponent.indexOf('<MapWorkspaceRecoverySurface');
    const bridgeIndex = mapComponent.indexOf('<ExperienceMapModeBridge');

    expect(recoveryIndex).toBeLessThan(bridgeIndex);
  });

  it('uses a full-width retry action on narrow recovery surfaces', () => {
    expect(recoveryCss).toMatch(
      /@media\(max-width:40rem\)[\s\S]*?\.map-workspace-recovery__retry\{inline-size:100%\}/u,
    );
  });

  it('keeps coarse-pointer mode and retry targets at 48px', () => {
    expect(modeCss).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.map-mode-experience__mode,[\s\S]*?min-block-size:\s*48px;/u,
    );
    expect(recoveryCss).toMatch(
      /@media\(pointer:coarse\)\{\.map-workspace-recovery__retry\{min-block-size:48px\}\}/u,
    );
  });

  it('preserves 44px minimum pointer targets outside coarse-pointer mode', () => {
    expect(modeCss).toMatch(
      /\.map-mode-experience__mode\s*\{[\s\S]*?min-block-size:\s*44px;/u,
    );
    expect(recoveryCss).toMatch(
      /\.map-workspace-recovery__retry\{[^}]*min-block-size:44px;/u,
    );
  });

  it('retains safe-area handling for the desktop mode overlay', () => {
    expect(modeCss).toContain('top: max(78px, calc(env(safe-area-inset-top) + 72px))');
    expect(modeCss).toContain('right: max(16px, env(safe-area-inset-right))');
  });

  it('retains safe-area handling for the mobile recovery sheet', () => {
    expect(recoveryCss).toContain('bottom:max(12px,env(safe-area-inset-bottom))');
  });

  it('keeps mode transitions motion-reduced without hiding the controls', () => {
    expect(modeCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(modeCss).toContain('animation: none');
    expect(modeCss).not.toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.map-mode-experience\s*\{[^}]*display:\s*none/u,
    );
  });

  it('keeps recovery usable under reduced motion', () => {
    expect(recoveryCss).toContain('@media(prefers-reduced-motion:reduce)');
    expect(recoveryCss).not.toMatch(
      /@media\(prefers-reduced-motion:reduce\)[\s\S]*?display:none/u,
    );
  });

  it('keeps forced-colors surfaces free of backdrop blur and custom shadows', () => {
    expect(modeCss).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?-webkit-backdrop-filter:\s*none;[\s\S]*?backdrop-filter:\s*none;/u,
    );
    expect(recoveryCss).toMatch(
      /@media\(forced-colors:active\)[\s\S]*?-webkit-backdrop-filter:none;backdrop-filter:none/u,
    );
  });

  it('retains visible focus rings in forced-colors mode', () => {
    expect(modeCss).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?\.map-mode-experience__mode:focus-visible,[\s\S]*?outline-color:\s*Highlight;/u,
    );
    expect(recoveryCss).toMatch(
      /@media\(forced-colors:active\)[\s\S]*?\.map-workspace-recovery__retry:focus-visible\{outline-color:Highlight\}/u,
    );
  });
});
