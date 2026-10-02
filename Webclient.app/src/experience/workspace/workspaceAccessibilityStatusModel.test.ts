import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceAccessibilityState } from './workspaceAccessibilityModel';
import {
  collectWorkspaceSurfaceFacts,
  createWorkspaceAccessibilityStatusSnapshot,
  workspaceStatusToneLabel,
  workspaceSurfaceActionZone,
} from './workspaceAccessibilityStatusModel';

describe('workspaceAccessibilityStatusModel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('collects canonical workspace surfaces from the live DOM', () => {
    document.body.innerHTML = `
      <main id="experience-workspace-controls"><button>Workspace</button></main>
      <aside id="sidebar"><button>Tools</button></aside>
      <div id="esri-map-container" tabindex="0"></div>
      <div data-experience-command-palette><input /></div>
      <div role="dialog"><button>Dialog</button></div>
    `;
    const facts = collectWorkspaceSurfaceFacts(document);
    expect(facts).toHaveLength(5);
    expect(facts.every((fact) => fact.available)).toBe(true);
    expect(facts.every((fact) => fact.focusable)).toBe(true);
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it('marks missing surfaces unavailable without inventing actions', () => {
    document.body.innerHTML = '<div id="esri-map-container"></div>';
    const facts = collectWorkspaceSurfaceFacts(document);
    expect(facts.find((fact) => fact.id === 'map')).toMatchObject({ available: true, focusable: false });
    expect(facts.find((fact) => fact.id === 'tools')).toMatchObject({ available: false, focusable: false });
  });

  it('recognizes focusable descendants inside landmark containers', () => {
    document.body.innerHTML = '<aside id="sidebar"><div><button>Layer</button></div></aside>';
    expect(collectWorkspaceSurfaceFacts(document).find((fact) => fact.id === 'tools')?.focusable).toBe(true);
  });

  it('does not count aria-hidden or hidden surfaces as focusable', () => {
    document.body.innerHTML = `
      <aside id="sidebar" aria-hidden="true"><button>Layer</button></aside>
      <div id="esri-map-container" hidden tabindex="0"></div>
    `;
    const facts = collectWorkspaceSurfaceFacts(document);
    expect(facts.find((fact) => fact.id === 'tools')?.focusable).toBe(false);
    expect(facts.find((fact) => fact.id === 'map')?.focusable).toBe(false);
  });

  it('creates a positive status when core surfaces are ready', () => {
    document.body.innerHTML = `
      <main id="experience-workspace-controls"><button>Workspace</button></main>
      <aside id="sidebar"><button>Tools</button></aside>
      <div id="esri-map-container" tabindex="0"></div>
    `;
    const accessibility = createWorkspaceAccessibilityState({
      focusZone: 'map',
      modality: 'keyboard',
      online: true,
      mapBusy: false,
    });
    const status = createWorkspaceAccessibilityStatusSnapshot(accessibility, collectWorkspaceSurfaceFacts(document));
    expect(status.headline).toContain('erişilebilir durumda');
    expect(status.hasCriticalIssue).toBe(false);
    expect(status.availableSurfaceCount).toBe(3);
    expect(status.focusableSurfaceCount).toBe(3);
    expect(status.items.find((item) => item.id === 'connectivity')?.tone).toBe('positive');
  });

  it('marks offline state as critical with clear explanatory summary', () => {
    const accessibility = createWorkspaceAccessibilityState({ online: false });
    const status = createWorkspaceAccessibilityStatusSnapshot(accessibility, collectWorkspaceSurfaceFacts(document));
    expect(status.hasCriticalIssue).toBe(true);
    expect(status.headline).toContain('dikkat');
    expect(status.summary).toContain('Ağ bağlantısı yok');
    expect(status.items.find((item) => item.id === 'connectivity')).toMatchObject({
      value: 'Çevrimdışı',
      tone: 'critical',
    });
  });

  it('marks a busy map as attention rather than a fatal state', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0"></div>';
    const accessibility = createWorkspaceAccessibilityState({ mapBusy: true, online: true, focusZone: 'map' });
    const status = createWorkspaceAccessibilityStatusSnapshot(accessibility, collectWorkspaceSurfaceFacts(document));
    expect(status.hasCriticalIssue).toBe(false);
    expect(status.hasAttentionIssue).toBe(true);
    expect(status.items.find((item) => item.id === 'map')).toMatchObject({
      value: 'Güncelleniyor',
      tone: 'attention',
      actionZone: 'map',
    });
  });

  it('describes reduced motion and forced colors as positive adaptations', () => {
    const accessibility = createWorkspaceAccessibilityState({ reducedMotion: true, forcedColors: true });
    const status = createWorkspaceAccessibilityStatusSnapshot(accessibility, collectWorkspaceSurfaceFacts(document));
    expect(status.items.find((item) => item.id === 'motion')).toMatchObject({
      value: 'Azaltılmış hareket etkin',
      tone: 'positive',
    });
    expect(status.items.find((item) => item.id === 'colors')).toMatchObject({
      value: 'Zorunlu renkler etkin',
      tone: 'positive',
    });
  });

  it('uses localized input modality labels', () => {
    const keyboard = createWorkspaceAccessibilityStatusSnapshot(
      createWorkspaceAccessibilityState({ modality: 'keyboard' }),
      collectWorkspaceSurfaceFacts(document),
    );
    const touch = createWorkspaceAccessibilityStatusSnapshot(
      createWorkspaceAccessibilityState({ modality: 'touch' }),
      collectWorkspaceSurfaceFacts(document),
    );
    expect(keyboard.items.find((item) => item.id === 'input')?.value).toBe('Klavye');
    expect(touch.items.find((item) => item.id === 'input')?.value).toBe('Dokunmatik');
  });

  it('uses the current focus zone in the visible status', () => {
    const status = createWorkspaceAccessibilityStatusSnapshot(
      createWorkspaceAccessibilityState({ focusZone: 'command-palette' }),
      collectWorkspaceSurfaceFacts(document),
    );
    expect(status.items.find((item) => item.id === 'focus')?.value).toBe('Komut merkezi');
  });

  it('flags unknown focus as attention without claiming a failure', () => {
    const status = createWorkspaceAccessibilityStatusSnapshot(
      createWorkspaceAccessibilityState({ focusZone: 'unknown' }),
      collectWorkspaceSurfaceFacts(document),
    );
    expect(status.items.find((item) => item.id === 'focus')?.tone).toBe('attention');
  });

  it('provides only actions for surfaces that currently exist', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0"></div>';
    const status = createWorkspaceAccessibilityStatusSnapshot(
      createWorkspaceAccessibilityState(),
      collectWorkspaceSurfaceFacts(document),
    );
    expect(status.items.find((item) => item.id === 'map')?.actionLabel).toBe('Harita alanına git');
    expect(status.items.find((item) => item.id === 'input')?.actionLabel).toBeNull();
  });

  it('keeps snapshots detached and immutable', () => {
    const facts = collectWorkspaceSurfaceFacts(document);
    const status = createWorkspaceAccessibilityStatusSnapshot(createWorkspaceAccessibilityState(), facts);
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.items)).toBe(true);
    expect(Object.isFrozen(status.surfaces)).toBe(true);
  });

  it.each([
    ['workspace', 'workspace'],
    ['tools', 'tools'],
    ['map', 'map'],
    ['command-palette', 'command-palette'],
    ['dialog', 'dialog'],
  ] as const)('maps %s surface to %s focus zone', (surface, zone) => {
    expect(workspaceSurfaceActionZone(surface)).toBe(zone);
  });

  it.each([
    ['positive', 'Hazır'],
    ['attention', 'İzleniyor'],
    ['critical', 'Dikkat'],
    ['neutral', 'Bilgi'],
  ] as const)('localizes %s status tone', (tone, label) => {
    expect(workspaceStatusToneLabel(tone)).toBe(label);
  });
});
