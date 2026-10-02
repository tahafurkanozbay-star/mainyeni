import type { MapWorkspaceShellRegionId, MapWorkspaceShellRegionState } from './mapWorkspaceShellModel';

export interface MapWorkspaceRegionGuideDefinition {
  readonly id: MapWorkspaceShellRegionId;
  readonly purpose: string;
  readonly keyboardHint: string;
  readonly availableLabel: string;
  readonly unavailableLabel: string;
}

export interface MapWorkspaceRegionGuideEntry extends MapWorkspaceShellRegionState {
  readonly purpose: string;
  readonly keyboardHint: string;
  readonly stateLabel: string;
}

export interface MapWorkspaceRegionGuideFinding {
  readonly code: 'duplicate-id' | 'missing-region' | 'empty-purpose' | 'empty-keyboard-hint';
  readonly regionId?: MapWorkspaceShellRegionId;
  readonly detail: string;
}

const regionGuide = (
  definition: MapWorkspaceRegionGuideDefinition,
): Readonly<MapWorkspaceRegionGuideDefinition> => Object.freeze({ ...definition });

export const MAP_WORKSPACE_REGION_GUIDE: readonly Readonly<MapWorkspaceRegionGuideDefinition>[] = Object.freeze([
  regionGuide({
    id: 'navigation',
    purpose: 'Ana menü, arama ve uygulama düzeyi geçişlere ulaşın.',
    keyboardHint: 'F6 ile bu bölgeye geçin; Tab ile menü eylemleri arasında ilerleyin.',
    availableLabel: 'Navigasyon kullanılabilir',
    unavailableLabel: 'Navigasyon şu anda kullanılamıyor',
  }),
  regionGuide({
    id: 'map',
    purpose: '2D/3D harita görünümünü klavye veya işaretçiyle inceleyin.',
    keyboardHint: 'F6 ile haritaya geçin; yön tuşları ve artı/eksi ile görünümü değiştirin.',
    availableLabel: 'Harita kullanılabilir',
    unavailableLabel: 'Harita şu anda kullanılamıyor',
  }),
  regionGuide({
    id: 'sidebar',
    purpose: 'Katmanları, belediye hizmetlerini, favorileri ve hızlı erişimleri yönetin.',
    keyboardHint: 'F6 ile panele geçin; Tab ve yön tuşlarıyla görünür kontrolleri kullanın.',
    availableLabel: 'Katman paneli kullanılabilir',
    unavailableLabel: 'Katman paneli şu anda kapalı',
  }),
  regionGuide({
    id: 'toolbar',
    purpose: 'Ölçüm, çizim, altlık, sorgu ve diğer harita araçlarına erişin.',
    keyboardHint: 'F6 ile araçlara geçin; roving odak desteklenen gruplarda yön tuşlarını kullanın.',
    availableLabel: 'Harita araçları kullanılabilir',
    unavailableLabel: 'Harita araçları şu anda kapalı',
  }),
  regionGuide({
    id: 'workspace',
    purpose: '2D/3D modu, görünüm tercihleri ve çalışma alanı durumunu yönetin.',
    keyboardHint: 'F6 ile görünüm kontrollerine geçin; Space veya Enter ile düğmeleri etkinleştirin.',
    availableLabel: 'Görünüm kontrolleri kullanılabilir',
    unavailableLabel: 'Görünüm kontrolleri şu anda kapalı',
  }),
  regionGuide({
    id: 'help',
    purpose: 'Kısayolları ve çalışma alanı rehberini açarak özellikleri keşfedin.',
    keyboardHint: 'F6 ile yardım düğmesine geçin veya Shift+? kısayolunu kullanın.',
    availableLabel: 'Yardım kullanılabilir',
    unavailableLabel: 'Yardım şu anda kapalı',
  }),
]);

const guideById = new Map<MapWorkspaceShellRegionId, Readonly<MapWorkspaceRegionGuideDefinition>>(
  MAP_WORKSPACE_REGION_GUIDE.map((definition) => [definition.id, definition]),
);

export const auditMapWorkspaceRegionGuide = (
  expectedRegionIds: readonly MapWorkspaceShellRegionId[],
  guide: readonly Readonly<MapWorkspaceRegionGuideDefinition>[] = MAP_WORKSPACE_REGION_GUIDE,
): readonly MapWorkspaceRegionGuideFinding[] => {
  const findings: MapWorkspaceRegionGuideFinding[] = [];
  const seen = new Set<MapWorkspaceShellRegionId>();

  for (const definition of guide) {
    if (seen.has(definition.id)) {
      findings.push(Object.freeze({
        code: 'duplicate-id',
        regionId: definition.id,
        detail: `Duplicate workspace region guide id: ${definition.id}`,
      }));
    }
    seen.add(definition.id);
    if (!definition.purpose.trim()) {
      findings.push(Object.freeze({
        code: 'empty-purpose',
        regionId: definition.id,
        detail: `Workspace region ${definition.id} requires a purpose.`,
      }));
    }
    if (!definition.keyboardHint.trim()) {
      findings.push(Object.freeze({
        code: 'empty-keyboard-hint',
        regionId: definition.id,
        detail: `Workspace region ${definition.id} requires keyboard guidance.`,
      }));
    }
  }

  for (const id of expectedRegionIds) {
    if (seen.has(id)) continue;
    findings.push(Object.freeze({
      code: 'missing-region',
      regionId: id,
      detail: `Workspace region ${id} is missing guide content.`,
    }));
  }

  return Object.freeze(findings);
};

export const getMapWorkspaceRegionGuide = (
  id: MapWorkspaceShellRegionId,
): Readonly<MapWorkspaceRegionGuideDefinition> => {
  const definition = guideById.get(id);
  if (!definition) throw new Error(`Missing workspace region guide: ${id}`);
  return definition;
};

export const buildMapWorkspaceRegionGuideEntries = (
  regions: readonly MapWorkspaceShellRegionState[],
): readonly MapWorkspaceRegionGuideEntry[] => Object.freeze(regions.map((region) => {
  const guide = getMapWorkspaceRegionGuide(region.id);
  return Object.freeze({
    ...region,
    purpose: guide.purpose,
    keyboardHint: guide.keyboardHint,
    stateLabel: region.available ? guide.availableLabel : guide.unavailableLabel,
  });
}));
