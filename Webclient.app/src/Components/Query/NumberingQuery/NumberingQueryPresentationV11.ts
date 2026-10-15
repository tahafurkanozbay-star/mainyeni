import {
  NUMBERING_LEVELS_V11,
  numberingLevelLabelV11,
  type NumberingLevelStateV11,
  type NumberingLevelV11,
  type NumberingPathV11,
  type NumberingRuntimeSnapshotV11,
} from './NumberingQueryContractsV11';

export type NumberingStepToneV11 = 'neutral' | 'info' | 'success' | 'danger';

export interface NumberingStepPresentationV11 {
  readonly level: NumberingLevelV11;
  readonly ordinal: number;
  readonly label: string;
  readonly shortLabel: string;
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly complete: boolean;
  readonly tone: NumberingStepToneV11;
  readonly filterLabel: string;
  readonly filterPlaceholder: string;
  readonly selectHint: string;
  readonly optionSummary: string;
  readonly statusText: string;
  readonly describedByIdSuffix: string;
}

export interface NumberingWorkspacePresentationV11 {
  readonly heading: string;
  readonly description: string;
  readonly pathLabel: string;
  readonly pathFallback: string;
  readonly progressLabel: string;
  readonly completionLabel: string;
  readonly liveStatus: string;
  readonly resetLabel: string;
  readonly steps: readonly NumberingStepPresentationV11[];
}

const shortLabel = (level: NumberingLevelV11): string => {
  if (level === 'district') return 'İlçe';
  if (level === 'neighborhood') return 'Mahalle';
  if (level === 'street') return 'Sokak';
  return 'Bina';
};

const filterPlaceholder = (level: NumberingLevelV11): string => {
  if (level === 'district') return 'İlçe adında ara…';
  if (level === 'neighborhood') return 'Mahalle adında ara…';
  if (level === 'street') return 'Cadde veya sokak adında ara…';
  return 'Bina numarasında ara…';
};

const filterLabel = (level: NumberingLevelV11): string =>
  `${numberingLevelLabelV11(level)} listesinde filtrele`;

const dependencyReady = (
  level: NumberingLevelV11,
  path: NumberingPathV11,
): boolean => {
  if (level === 'district') return true;
  if (level === 'neighborhood') return Boolean(path.district);
  if (level === 'street') return Boolean(path.neighborhood);
  return Boolean(path.street);
};

const optionSummary = (state: NumberingLevelStateV11): string => {
  if (state.status === 'loading') return `${numberingLevelLabelV11(state.level)} seçenekleri yükleniyor.`;
  if (state.optionCount === 0) {
    return state.selected
      ? `${state.selected.label} seçili.`
      : `${numberingLevelLabelV11(state.level)} seçeneği henüz yok.`;
  }
  if (state.filter) {
    return `${state.optionCount.toLocaleString('tr-TR')} kayıtta ${state.visibleOptionCount.toLocaleString('tr-TR')} görünür eşleşme.`;
  }
  return `${state.optionCount.toLocaleString('tr-TR')} seçenek hazır.`;
};

const selectHint = (
  state: NumberingLevelStateV11,
  enabled: boolean,
): string => {
  if (!enabled) return 'Önce bir önceki adres adımını seçin.';
  if (state.status === 'loading') return 'Veri yüklenirken seçim geçici olarak kapalıdır.';
  if (state.error) return state.error;
  if (state.message) return state.message;
  if (state.truncated) return 'Büyük liste performans için sınırlandırıldı; filtre alanını kullanarak aradığınız seçeneği daraltın.';
  if (state.optionCount > 0) return 'Listeden bir değer seçin. Seçim, sonraki adres adımını yükler.';
  return 'Bu seviyede kullanılabilir kayıt bulunamadı.';
};

const toneFor = (
  state: NumberingLevelStateV11,
): NumberingStepToneV11 => {
  if (state.error) return 'danger';
  if (state.status === 'loading') return 'info';
  if (state.selected) return 'success';
  return 'neutral';
};

const statusText = (
  state: NumberingLevelStateV11,
): string => {
  if (state.error) return state.error;
  if (state.message) return state.message;
  if (state.status === 'loading') return `${numberingLevelLabelV11(state.level)} yükleniyor.`;
  if (state.selected) return `${state.selected.label} seçildi.`;
  return optionSummary(state);
};

export const createNumberingStepPresentationV11 = (
  snapshot: NumberingRuntimeSnapshotV11,
  level: NumberingLevelV11,
): NumberingStepPresentationV11 => {
  const state = snapshot.levels[level];
  const ordinal = NUMBERING_LEVELS_V11.indexOf(level) + 1;
  const enabled = !snapshot.disposed && dependencyReady(level, snapshot.path);
  return Object.freeze({
    level,
    ordinal,
    label: numberingLevelLabelV11(level),
    shortLabel: shortLabel(level),
    enabled,
    busy: state.status === 'loading',
    complete: Boolean(state.selected),
    tone: toneFor(state),
    filterLabel: filterLabel(level),
    filterPlaceholder: filterPlaceholder(level),
    selectHint: selectHint(state, enabled),
    optionSummary: optionSummary(state),
    statusText: statusText(state),
    describedByIdSuffix: `${level}-description`,
  });
};

const progressLabel = (snapshot: NumberingRuntimeSnapshotV11): string => {
  const completed = NUMBERING_LEVELS_V11.filter(level => snapshot.levels[level].selected).length;
  return `Adres adımlarının ${completed} / ${NUMBERING_LEVELS_V11.length} tanesi tamamlandı.`;
};

const liveStatus = (snapshot: NumberingRuntimeSnapshotV11): string => {
  if (snapshot.disposed) return 'Adres arama kapatıldı.';
  const active = snapshot.activeLevel;
  if (active) return `${numberingLevelLabelV11(active)} bilgileri yükleniyor.`;
  const errorLevel = NUMBERING_LEVELS_V11.find(level => snapshot.levels[level].error);
  if (errorLevel) return snapshot.levels[errorLevel].error;
  if (snapshot.complete) return `Adres seçimi tamamlandı: ${snapshot.pathLabel}.`;
  if (snapshot.pathLabel) return `Seçili adres: ${snapshot.pathLabel}.`;
  if (snapshot.initialized) return 'İlçe seçerek adres aramaya başlayın.';
  return 'Adres arama hazırlanıyor.';
};

export const createNumberingWorkspacePresentationV11 = (
  snapshot: NumberingRuntimeSnapshotV11,
): NumberingWorkspacePresentationV11 => Object.freeze({
  heading: 'Adres Arama',
  description: 'İlçe, mahalle, cadde veya sokak ve bina numarasını adım adım seçin. Büyük listelerde filtre alanını kullanabilirsiniz.',
  pathLabel: snapshot.pathLabel,
  pathFallback: 'Henüz adres seçilmedi.',
  progressLabel: progressLabel(snapshot),
  completionLabel: snapshot.complete
    ? 'Adres tamamlandı ve harita bina konumuna odaklandı.'
    : 'Adres seçimi devam ediyor.',
  liveStatus: liveStatus(snapshot),
  resetLabel: snapshot.canReset ? 'Adres seçimini temizle' : 'Adres seçimini temizle',
  steps: Object.freeze(NUMBERING_LEVELS_V11.map(level =>
    createNumberingStepPresentationV11(snapshot, level))),
});

export const numberingSelectionValueV11 = (
  snapshot: NumberingRuntimeSnapshotV11,
  level: NumberingLevelV11,
): string => snapshot.levels[level].selected?.value ?? '';

export const numberingStepDisabledV11 = (
  snapshot: NumberingRuntimeSnapshotV11,
  level: NumberingLevelV11,
): boolean => {
  const step = createNumberingStepPresentationV11(snapshot, level);
  return !step.enabled || step.busy || snapshot.disposed;
};

export const numberingFilterDisabledV11 = (
  snapshot: NumberingRuntimeSnapshotV11,
  level: NumberingLevelV11,
): boolean => {
  const state = snapshot.levels[level];
  const step = createNumberingStepPresentationV11(snapshot, level);
  return !step.enabled || state.optionCount === 0 || snapshot.disposed;
};
