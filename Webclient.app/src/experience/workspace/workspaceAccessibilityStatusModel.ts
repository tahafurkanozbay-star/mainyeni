import type { WorkspaceAccessibilitySnapshot, WorkspaceFocusZone } from './workspaceAccessibilityModel';

export type WorkspaceSurfaceId = 'workspace' | 'tools' | 'map' | 'command-palette' | 'dialog';
export type WorkspaceStatusTone = 'neutral' | 'positive' | 'attention' | 'critical';

export interface WorkspaceSurfaceFact {
  readonly id: WorkspaceSurfaceId;
  readonly available: boolean;
  readonly focusable: boolean;
  readonly label: string;
}

export interface WorkspaceAccessibilityStatusItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone: WorkspaceStatusTone;
  readonly actionZone: WorkspaceFocusZone | null;
  readonly actionLabel: string | null;
}

export interface WorkspaceAccessibilityStatusSnapshot {
  readonly revision: number;
  readonly headline: string;
  readonly summary: string;
  readonly items: readonly WorkspaceAccessibilityStatusItem[];
  readonly surfaces: readonly WorkspaceSurfaceFact[];
  readonly availableSurfaceCount: number;
  readonly focusableSurfaceCount: number;
  readonly hasCriticalIssue: boolean;
  readonly hasAttentionIssue: boolean;
}

export interface WorkspaceSurfaceDocumentLike {
  readonly querySelector: (selector: string) => Element | null;
}

const SURFACES: readonly Readonly<{
  id: WorkspaceSurfaceId;
  selector: string;
  label: string;
  focusZone: WorkspaceFocusZone;
}>[] = Object.freeze([
  Object.freeze({ id: 'workspace', selector: '#experience-workspace-controls,[data-workspace-shell]', label: 'Çalışma alanı', focusZone: 'workspace' }),
  Object.freeze({ id: 'tools', selector: '#sidebar,[data-workspace-tools]', label: 'Araçlar', focusZone: 'tools' }),
  Object.freeze({ id: 'map', selector: '#esri-map-container,[data-workspace-map]', label: 'Harita', focusZone: 'map' }),
  Object.freeze({ id: 'command-palette', selector: '[data-experience-command-palette]', label: 'Komut merkezi', focusZone: 'command-palette' }),
  Object.freeze({ id: 'dialog', selector: '[role="dialog"],[aria-modal="true"]', label: 'Açık iletişim penceresi', focusZone: 'dialog' }),
]);

const isElementFocusable = (element: Element): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  if (element.matches('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')) return true;
  if (element.tabIndex >= 0) return true;
  return Boolean(element.querySelector('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])'));
};

export const collectWorkspaceSurfaceFacts = (
  doc: WorkspaceSurfaceDocumentLike | null | undefined,
): readonly WorkspaceSurfaceFact[] => Object.freeze(SURFACES.map((surface) => {
  const element = doc?.querySelector(surface.selector) ?? null;
  return Object.freeze({
    id: surface.id,
    available: element !== null,
    focusable: element ? isElementFocusable(element) : false,
    label: surface.label,
  });
}));

const statusItem = (
  id: string,
  label: string,
  value: string,
  tone: WorkspaceStatusTone,
  actionZone: WorkspaceFocusZone | null = null,
  actionLabel: string | null = null,
): WorkspaceAccessibilityStatusItem => Object.freeze({ id, label, value, tone, actionZone, actionLabel });

const labelForModality = (snapshot: WorkspaceAccessibilitySnapshot): string => {
  switch (snapshot.modality) {
    case 'keyboard': return 'Klavye';
    case 'touch': return 'Dokunmatik';
    case 'pointer': return 'İşaretçi';
    default: return 'Henüz belirlenmedi';
  }
};

const labelForFocusZone = (zone: WorkspaceFocusZone): string => {
  switch (zone) {
    case 'workspace': return 'Çalışma alanı';
    case 'tools': return 'Araç paneli';
    case 'map': return 'Harita';
    case 'dialog': return 'İletişim penceresi';
    case 'command-palette': return 'Komut merkezi';
    default: return 'Sayfa geneli';
  }
};

const surfaceAction = (
  surfaces: readonly WorkspaceSurfaceFact[],
  id: WorkspaceSurfaceId,
): Readonly<{ zone: WorkspaceFocusZone | null; label: string | null }> => {
  const definition = SURFACES.find((candidate) => candidate.id === id);
  const fact = surfaces.find((candidate) => candidate.id === id);
  if (!definition || !fact?.available) return Object.freeze({ zone: null, label: null });
  return Object.freeze({ zone: definition.focusZone, label: `${definition.label} alanına git` });
};

export const createWorkspaceAccessibilityStatusSnapshot = (
  accessibility: WorkspaceAccessibilitySnapshot,
  surfaces: readonly WorkspaceSurfaceFact[],
): WorkspaceAccessibilityStatusSnapshot => {
  const availableSurfaceCount = surfaces.filter((surface) => surface.available).length;
  const focusableSurfaceCount = surfaces.filter((surface) => surface.available && surface.focusable).length;
  const mapAction = surfaceAction(surfaces, 'map');
  const toolsAction = surfaceAction(surfaces, 'tools');
  const workspaceAction = surfaceAction(surfaces, 'workspace');

  const items: readonly WorkspaceAccessibilityStatusItem[] = Object.freeze([
    statusItem(
      'connectivity',
      'Bağlantı',
      accessibility.online ? 'Çevrimiçi' : 'Çevrimdışı',
      accessibility.online ? 'positive' : 'critical',
    ),
    statusItem(
      'map',
      'Harita durumu',
      accessibility.mapBusy ? 'Güncelleniyor' : 'Hazır',
      accessibility.mapBusy ? 'attention' : 'positive',
      mapAction.zone,
      mapAction.label,
    ),
    statusItem(
      'focus',
      'Odak konumu',
      labelForFocusZone(accessibility.focusZone),
      accessibility.focusZone === 'unknown' ? 'attention' : 'neutral',
      workspaceAction.zone,
      workspaceAction.label,
    ),
    statusItem(
      'input',
      'Giriş yöntemi',
      labelForModality(accessibility),
      'neutral',
      toolsAction.zone,
      toolsAction.label,
    ),
    statusItem(
      'motion',
      'Hareket tercihi',
      accessibility.reducedMotion ? 'Azaltılmış hareket etkin' : 'Standart hareket',
      accessibility.reducedMotion ? 'positive' : 'neutral',
    ),
    statusItem(
      'colors',
      'Renk modu',
      accessibility.forcedColors ? 'Zorunlu renkler etkin' : 'Uygulama renkleri',
      accessibility.forcedColors ? 'positive' : 'neutral',
    ),
    statusItem(
      'surfaces',
      'Erişilebilir yüzeyler',
      `${focusableSurfaceCount}/${availableSurfaceCount || surfaces.length} odaklanabilir`,
      availableSurfaceCount >= 3 && focusableSurfaceCount >= 2 ? 'positive' : 'attention',
    ),
  ]);

  const hasCriticalIssue = items.some((item) => item.tone === 'critical');
  const hasAttentionIssue = items.some((item) => item.tone === 'attention');
  const headline = hasCriticalIssue
    ? 'Çalışma alanında dikkat gerektiren durum var'
    : hasAttentionIssue
      ? 'Çalışma alanı kullanılabilir, bazı durumlar izleniyor'
      : 'Çalışma alanı erişilebilir durumda';
  const summary = accessibility.online
    ? accessibility.mapBusy
      ? 'Bağlantı etkin. Harita güncellenirken diğer araçları kullanmaya devam edebilirsiniz.'
      : 'Harita ve temel çalışma alanı kontrolleri kullanıma hazır.'
    : 'Ağ bağlantısı yok. Haritadaki bazı bilgiler güncel olmayabilir; sayfadaki mevcut kontroller kullanılabilir.';

  return Object.freeze({
    revision: accessibility.sequence,
    headline,
    summary,
    items,
    surfaces: Object.freeze(surfaces.map((surface) => Object.freeze({ ...surface }))),
    availableSurfaceCount,
    focusableSurfaceCount,
    hasCriticalIssue,
    hasAttentionIssue,
  });
};

export const workspaceSurfaceActionZone = (id: WorkspaceSurfaceId): WorkspaceFocusZone => (
  SURFACES.find((surface) => surface.id === id)?.focusZone ?? 'unknown'
);

export const workspaceStatusToneLabel = (tone: WorkspaceStatusTone): string => {
  switch (tone) {
    case 'positive': return 'Hazır';
    case 'attention': return 'İzleniyor';
    case 'critical': return 'Dikkat';
    default: return 'Bilgi';
  }
};
