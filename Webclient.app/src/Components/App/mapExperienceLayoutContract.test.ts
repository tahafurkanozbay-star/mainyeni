import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webclientRoot = process.cwd().endsWith('Webclient.app') ? process.cwd() : resolve(process.cwd(), 'Webclient.app');
const read = (name: string): string => readFileSync(resolve(webclientRoot, 'src', 'Components', 'App', name), 'utf8');

const modeCss = read('MapModeExperienceControl.css');
const recoveryCss = read('MapWorkspaceRecoverySurface.css');
const mapCss = read('MapComponent.css');
const mapComponent = read('MapComponent.tsx');
const application = readFileSync(resolve(webclientRoot, 'src', 'App.tsx'), 'utf8');
const toolbarComponent = readFileSync(resolve(webclientRoot, 'src', 'Components', 'Widget', 'Toolbar', 'ToolbarWidgetModern.tsx'), 'utf8');
const toolbarCss = readFileSync(resolve(webclientRoot, 'src', 'Components', 'Widget', 'Toolbar', 'ToolbarWidget.css'), 'utf8');
const navigationCss = read('NavigationBar.css');
const sidebarModernCss = read('SidebarModern.css');
const attributionCss = read('OpenStreetMap3DAttribution.css');
const mapModeBridge = read('ExperienceMapModeBridge.tsx');
const legacySidebarCss = read('Sidebar.css');
const shellCss = readFileSync(resolve(webclientRoot, 'src', 'Components', 'Common', 'experience-shell.css'), 'utf8');
const uiCss = readFileSync(resolve(webclientRoot, 'src', 'Components', 'Common', 'experience-ui.css'), 'utf8');
const disclaimerCss = readFileSync(resolve(webclientRoot, 'src', 'Components', 'Common', 'experience-data-disclaimer.css'), 'utf8');

const mobileModeBlock = (): string => {
  const mediaStart = modeCss.indexOf('@media (max-width: 45rem)');
  expect(mediaStart).toBeGreaterThanOrEqual(0);
  const nextMedia = modeCss.indexOf('@media (pointer: coarse)', mediaStart);
  expect(nextMedia).toBeGreaterThan(mediaStart);
  return modeCss.slice(mediaStart, nextMedia);
};

describe('map experience layout collision contract', () => {
  it('anchors Keşfet to the left edge and bounds it between the header and viewport bottom', () => {
    expect(mapCss).toMatch(
      /\.esri-map > \.sidebar-container\.kr-sidebar--governed\s*\{[\s\S]*?inset-inline-start:\s*0;[\s\S]*?inset-block-end:\s*0;[\s\S]*?height:\s*auto;/u,
    );
    expect(mapCss).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.esri-map > \.sidebar-container\.kr-sidebar--governed\s*\{[\s\S]*?top:\s*58px;[\s\S]*?max-width:\s*100dvw;/u,
    );
  });

  it('keeps a visible keyboard focus indicator on legacy sidebar buttons', () => {
    expect(legacySidebarCss).not.toMatch(/\.sidebar-header button\s*\{[^}]*outline:\s*none;/u);
    expect(legacySidebarCss).toMatch(/\.sidebar-header button:focus-visible\s*\{[^}]*outline:\s*3px solid/u);
    expect(legacySidebarCss).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.sidebar-header button:focus-visible\s*\{[^}]*outline-color:\s*Highlight;/u);
  });

  it('uses translucent frosted surfaces on Keşfet, query windows, and the shell', () => {
    expect(sidebarModernCss).toContain('background: color-mix(in srgb, var(--exp-surface, #fff) 84%, transparent);');
    expect(uiCss).toContain('background: color-mix(in srgb, var(--exp-surface) 84%, transparent);');
    expect(shellCss).toContain('background: color-mix(in srgb, var(--exp-surface) 84%, transparent);');
    expect(navigationCss).toContain('backdrop-filter:blur(12px);');
  });

  it('keeps the bottom disclaimer on one full-width line, including compact screens', () => {
    expect(disclaimerCss).toContain('inline-size: 100dvw;');
    expect(disclaimerCss).toMatch(
      /\.experience-data-disclaimer__copy\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?white-space:\s*nowrap;/u,
    );
    expect(disclaimerCss).toMatch(
      /@media \(max-width: 40rem\)[\s\S]*?\.experience-data-disclaimer__copy\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?white-space:\s*nowrap;/u,
    );
    expect(disclaimerCss).toMatch(/\.experience-data-disclaimer__icon\s*\{\s*display:\s*none;/u);
  });

  it('removes the decorative lower-right map badge while preserving OSM credit', () => {
    expect(attributionCss).toContain('top: calc(var(--mainbar-height, 60px) + 8px);');
    expect(attributionCss).toContain('bottom: auto;');
    expect(attributionCss).toContain('background: transparent;');
    expect(mapModeBridge).toContain('© OpenStreetMap contributors');
    expect(mapModeBridge).not.toContain('3B bina verisi:');
  });


  it('mounts service query results inside the existing Keşfet panel instead of as map siblings', () => {
    const sidebarComponent = read('SidebarModern.tsx');
    const sidebarCss = read('SidebarModern.css');

    expect(mapComponent).toContain('createPortal(');
    expect(mapComponent).toContain('onToolHostChange={setSidebarToolHost}');
    expect(mapComponent).toContain('QUERY_WINDOW_DEFINITIONS.map');
    expect(sidebarComponent).toContain('className="kr-sidebar__tool-slot"');
    expect(sidebarCss).toContain(':has(.kr-sidebar__tool-slot > .sidebar-container[aria-hidden="false"])');
    expect(sidebarCss).toMatch(/\.kr-sidebar--governed:has\([\s\S]*?\)\s+\.kr-sidebar__panel,?[\s\S]*?\{\s*display: none;/u);
  });


  it('keeps Keşfet out of the generic tool-panel stacking rule so opened subcategory panels can sit in front', () => {
    expect(mapCss).toMatch(
      /\.esri-map > \.sidebar-container:not\(\.kr-sidebar\),\s*\.esri-map > \.sidebar-container1:not\(\.kr-sidebar\)\s*\{\s*position:\s*relative;\s*z-index:\s*20;/u,
    );
    expect(mapCss).not.toMatch(
      /\.esri-map > \.sidebar-container,\s*\.esri-map > \.sidebar-container1\s*\{\s*position:\s*relative;\s*z-index:\s*20;/u,
    );
    expect(mapCss).toContain('z-index: var(--experience-z-panel, 30);');
  });


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

  it('hosts the 2B/3B switcher inside the right toolbar instead of a separate floating panel', () => {
    expect(application).toContain('<ExperienceWorkspace externalMapModeControl />');
    expect(toolbarComponent).toContain('leadingContent={<MapModeExperienceControl embedded />}');
    expect(toolbarComponent).toContain('toolbarwidget--with-map-mode');
    expect(toolbarCss).toContain('--toolbar-width: 100px;');
    expect(modeCss).toContain('.map-mode-experience--embedded');
  });

  it('keeps the actual ArcGIS bridge in the map and the mode control in the right toolbar', () => {
    const bridgeIndex = mapComponent.indexOf('<ExperienceMapModeBridge');
    expect(bridgeIndex).toBeGreaterThan(mapComponent.indexOf('{mapView && <>'));
    expect(mapComponent).not.toContain('<MapModeExperienceControl />');
    expect(toolbarComponent).toContain('leadingContent={<MapModeExperienceControl embedded />}');
  });

  it('pins the mainbar flush to the viewport top without inherited spacing or offsets', () => {
    expect(navigationCss).toContain('html,body,#root,#app-shell{margin:0!important;padding:0!important;}');
    expect(navigationCss).toContain('.mainbar-container{position:fixed!important;top:0!important;inset-block-start:0!important;');
    expect(mapCss).toMatch(/\.esri-map > \.mainbar-container\s*\{\s*position: fixed !important;\s*top: 0 !important;/u);
    expect(mapCss).toMatch(/#app-shell \.esri-map > #mainbar\.mainbar-container\s*\{[\s\S]*?inset-block-start: 0 !important;[\s\S]*?margin: 0 !important;/u);
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
