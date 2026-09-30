import type {
  MapWorkspaceAccessibilitySnapshot,
  MapWorkspaceHealth,
  MapWorkspaceResourceSnapshot,
} from './mapWorkspaceAccessibility';

export type MapWorkspaceHealthTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
export type MapWorkspaceHealthActionId = 'retry-workspace' | 'open-help' | 'reload-page';

export interface MapWorkspaceHealthAction {
  readonly id: MapWorkspaceHealthActionId;
  readonly label: string;
  readonly emphasis: 'primary' | 'secondary';
}

export interface MapWorkspaceHealthResourceRow {
  readonly key: MapWorkspaceResourceSnapshot['key'];
  readonly label: string;
  readonly statusLabel: string;
  readonly tone: MapWorkspaceHealthTone;
  readonly message: string | null;
}

export interface MapWorkspaceHealthPresentation {
  readonly visible: boolean;
  readonly tone: MapWorkspaceHealthTone;
  readonly role: 'status' | 'alert';
  readonly live: 'polite' | 'assertive';
  readonly title: string;
  readonly description: string;
  readonly badge: string;
  readonly attemptLabel: string | null;
  readonly progressLabel: string | null;
  readonly actions: readonly MapWorkspaceHealthAction[];
  readonly resources: readonly MapWorkspaceHealthResourceRow[];
  readonly showDiagnostics: boolean;
}

const statusLabelFor = (resource: MapWorkspaceResourceSnapshot): string => {
  switch (resource.status) {
    case 'idle': return 'Bekliyor';
    case 'loading': return 'Yükleniyor';
    case 'ready': return 'Hazır';
    case 'degraded': return 'Sınırlı';
    case 'failed': return 'Kullanılamıyor';
  }
};

const toneForResource = (resource: MapWorkspaceResourceSnapshot): MapWorkspaceHealthTone => {
  switch (resource.status) {
    case 'idle': return 'neutral';
    case 'loading': return 'progress';
    case 'ready': return 'success';
    case 'degraded': return 'warning';
    case 'failed': return 'danger';
  }
};

const resourceRows = (
  resources: readonly MapWorkspaceResourceSnapshot[],
): readonly MapWorkspaceHealthResourceRow[] => Object.freeze(resources.map((resource) => Object.freeze({
  key: resource.key,
  label: resource.label,
  statusLabel: statusLabelFor(resource),
  tone: toneForResource(resource),
  message: resource.message,
})));

const toneForHealth = (health: MapWorkspaceHealth): MapWorkspaceHealthTone => {
  switch (health) {
    case 'starting': return 'neutral';
    case 'healthy': return 'success';
    case 'busy': return 'progress';
    case 'degraded': return 'warning';
    case 'failed': return 'danger';
  }
};

const actionsFor = (snapshot: MapWorkspaceAccessibilitySnapshot): readonly MapWorkspaceHealthAction[] => {
  const actions: MapWorkspaceHealthAction[] = [];
  if (snapshot.phase === 'error' && snapshot.canRetry) {
    actions.push(Object.freeze({ id: 'retry-workspace', label: 'Haritayı yeniden başlat', emphasis: 'primary' }));
  } else if (snapshot.phase === 'error' && snapshot.retryExhausted) {
    actions.push(Object.freeze({ id: 'reload-page', label: 'Sayfayı yenile', emphasis: 'primary' }));
  }
  if (snapshot.phase === 'degraded' || snapshot.phase === 'error' || snapshot.isDelayed) {
    actions.push(Object.freeze({ id: 'open-help', label: 'Çalışma rehberini aç', emphasis: 'secondary' }));
  }
  return Object.freeze(actions);
};

const titleFor = (snapshot: MapWorkspaceAccessibilitySnapshot): string => {
  if (snapshot.phase === 'error') return 'Harita çalışma alanı başlatılamadı';
  if (snapshot.phase === 'degraded') return 'Harita sınırlı özelliklerle çalışıyor';
  if (snapshot.phase === 'booting' && snapshot.isDelayed) return 'Harita hazırlanıyor';
  if (snapshot.phase === 'booting') return 'Harita çalışma alanı hazırlanıyor';
  if (snapshot.phase === 'updating' && snapshot.isDelayed) return 'Harita güncellemesi sürüyor';
  if (snapshot.phase === 'updating') return 'Harita güncelleniyor';
  return 'Harita hazır';
};

const descriptionFor = (snapshot: MapWorkspaceAccessibilitySnapshot): string => {
  if (snapshot.phase === 'error') {
    if (snapshot.retryExhausted) {
      return 'Güvenli yeniden başlatma denemeleri tamamlandı. Sayfayı yenileyerek yeni bir oturum başlatabilirsiniz.';
    }
    return snapshot.errorMessage
      ? `Harita görünümü kurulamadı. ${snapshot.errorMessage}`
      : 'Harita görünümü kurulamadı. Bağlantınızı kontrol edip tekrar deneyebilirsiniz.';
  }
  if (snapshot.phase === 'degraded') {
    return 'Ana harita kullanılabilir. Bazı veri veya yardımcı kaynaklar geçici olarak sınırlı olabilir.';
  }
  if (snapshot.phase === 'booting' && snapshot.isDelayed) {
    return 'Harita motoru yanıt veriyor ancak başlangıç beklenenden uzun sürüyor. Bu sırada sayfayı kapatmadan bekleyebilir veya yardım rehberini açabilirsiniz.';
  }
  if (snapshot.phase === 'booting') {
    return 'Harita motoru, görünüm ve temel çalışma alanı kaynakları hazırlanıyor.';
  }
  if (snapshot.phase === 'updating' && snapshot.isDelayed) {
    return 'Görünüm güncellemesi beklenenden uzun sürüyor. Harita etkileşimi korunuyor; işlem tamamlandığında bu bildirim kapanacaktır.';
  }
  if (snapshot.phase === 'updating') {
    return 'Harita görünümü yeni duruma göre güncelleniyor.';
  }
  return 'Harita görünümü ve temel çalışma alanı kaynakları kullanıma hazır.';
};

const badgeFor = (snapshot: MapWorkspaceAccessibilitySnapshot): string => {
  if (snapshot.phase === 'error') return 'Hata';
  if (snapshot.phase === 'degraded') return 'Sınırlı';
  if (snapshot.isDelayed) return 'Uzun sürüyor';
  if (snapshot.phase === 'booting') return 'Başlatılıyor';
  if (snapshot.phase === 'updating') return 'Güncelleniyor';
  return 'Hazır';
};

const progressLabelFor = (snapshot: MapWorkspaceAccessibilitySnapshot): string | null => {
  if (snapshot.phase === 'booting') return `Başlatma denemesi ${Math.max(1, snapshot.attempt)} / ${snapshot.maxAttempts}`;
  if (snapshot.phase === 'updating') return 'Harita görünümü güncelleniyor';
  return null;
};

export const shouldShowMapWorkspaceHealthPanel = (snapshot: MapWorkspaceAccessibilitySnapshot): boolean => {
  if (snapshot.phase === 'error' || snapshot.phase === 'degraded') return true;
  if (snapshot.phase === 'booting') return true;
  return snapshot.phase === 'updating' && snapshot.isDelayed;
};

export const createMapWorkspaceHealthPresentation = (
  snapshot: MapWorkspaceAccessibilitySnapshot,
): MapWorkspaceHealthPresentation => Object.freeze({
  visible: shouldShowMapWorkspaceHealthPanel(snapshot),
  tone: toneForHealth(snapshot.health),
  role: snapshot.phase === 'error' ? 'alert' : 'status',
  live: snapshot.phase === 'error' ? 'assertive' : 'polite',
  title: titleFor(snapshot),
  description: descriptionFor(snapshot),
  badge: badgeFor(snapshot),
  attemptLabel: snapshot.phase === 'error' || snapshot.phase === 'booting'
    ? `Deneme ${snapshot.attempt} / ${snapshot.maxAttempts}`
    : null,
  progressLabel: progressLabelFor(snapshot),
  actions: actionsFor(snapshot),
  resources: resourceRows(snapshot.resources),
  showDiagnostics: snapshot.issueCount > 0 || snapshot.isDelayed || snapshot.phase === 'error',
});
