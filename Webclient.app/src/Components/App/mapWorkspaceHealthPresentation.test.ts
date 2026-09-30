import { describe, expect, it } from 'vitest';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import {
  createMapWorkspaceHealthPresentation,
  shouldShowMapWorkspaceHealthPanel,
} from './mapWorkspaceHealthPresentation';

const createReadyModel = (): MapWorkspaceAccessibilityModel => {
  const model = new MapWorkspaceAccessibilityModel();
  model.beginAttempt();
  model.markReady();
  return model;
};

describe('mapWorkspaceHealthPresentation', () => {
  it('shows a neutral starting surface during initial boot', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: true,
      tone: 'neutral',
      role: 'status',
      live: 'polite',
      title: 'Harita çalışma alanı hazırlanıyor',
      badge: 'Başlatılıyor',
      attemptLabel: 'Deneme 1 / 3',
      progressLabel: 'Başlatma denemesi 1 / 3',
      showDiagnostics: false,
    });
    expect(presentation.actions).toEqual([]);
  });

  it('keeps healthy ready state out of the visual overlay', () => {
    const model = createReadyModel();
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: false,
      tone: 'success',
      title: 'Harita hazır',
      badge: 'Hazır',
      progressLabel: null,
      showDiagnostics: false,
    });
    expect(shouldShowMapWorkspaceHealthPanel(model.getSnapshot())).toBe(false);
  });

  it('keeps a normal short map update visually quiet', () => {
    const model = createReadyModel();
    model.markUpdating(true);
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: false,
      tone: 'progress',
      title: 'Harita güncelleniyor',
      progressLabel: 'Harita görünümü güncelleniyor',
    });
  });

  it('surfaces delayed map update as progress instead of an error', () => {
    const callbacks: Array<() => void> = [];
    const model = new MapWorkspaceAccessibilityModel({
      scheduleTimeout(callback) {
        callbacks.push(callback);
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout() {},
    });
    model.beginAttempt();
    model.markReady();
    model.markUpdating(true);
    callbacks.at(-1)?.();
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: true,
      tone: 'progress',
      role: 'status',
      live: 'polite',
      title: 'Harita güncellemesi sürüyor',
      badge: 'Uzun sürüyor',
      showDiagnostics: true,
    });
    expect(presentation.description).toContain('Harita etkileşimi korunuyor');
    expect(presentation.actions).toEqual([
      expect.objectContaining({ id: 'open-help', emphasis: 'secondary' }),
    ]);
  });

  it('surfaces delayed boot and keeps retry unavailable before a real failure', () => {
    const callbacks: Array<() => void> = [];
    const model = new MapWorkspaceAccessibilityModel({
      scheduleTimeout(callback) {
        callbacks.push(callback);
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout() {},
    });
    model.beginAttempt();
    callbacks.at(-1)?.();
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: true,
      tone: 'progress',
      title: 'Harita hazırlanıyor',
      badge: 'Uzun sürüyor',
      attemptLabel: 'Deneme 1 / 3',
      showDiagnostics: true,
    });
    expect(presentation.actions.some((action) => action.id === 'retry-workspace')).toBe(false);
    expect(presentation.actions.some((action) => action.id === 'open-help')).toBe(true);
  });

  it('renders optional data loss as a warning and preserves help action', () => {
    const model = createReadyModel();
    model.markResourceFailed('kent-rehberi-data', 'Veri katmanı geçici olarak kullanılamıyor.');
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: true,
      tone: 'warning',
      title: 'Harita sınırlı özelliklerle çalışıyor',
      badge: 'Sınırlı',
      role: 'status',
      live: 'polite',
      showDiagnostics: true,
    });
    expect(presentation.description).toContain('Ana harita kullanılabilir');
    expect(presentation.actions).toEqual([
      expect.objectContaining({ id: 'open-help', label: 'Çalışma rehberini aç' }),
    ]);
  });

  it('maps resource states to human-readable rows', () => {
    const model = createReadyModel();
    model.markResourceLoading('kent-rehberi-data');
    let presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation.resources).toEqual([
      expect.objectContaining({ key: 'map-view', statusLabel: 'Hazır', tone: 'success' }),
      expect.objectContaining({ key: 'kent-rehberi-data', statusLabel: 'Yükleniyor', tone: 'progress' }),
    ]);

    model.markResourceFailed('kent-rehberi-data', 'temporary');
    presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation.resources[1]).toMatchObject({
      key: 'kent-rehberi-data',
      statusLabel: 'Sınırlı',
      tone: 'warning',
      message: 'temporary',
    });
  });

  it('renders first fatal failure with an assertive retry action', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError(new Error('MapView kurulamadı'));
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      visible: true,
      tone: 'danger',
      role: 'alert',
      live: 'assertive',
      title: 'Harita çalışma alanı başlatılamadı',
      badge: 'Hata',
      attemptLabel: 'Deneme 1 / 3',
      showDiagnostics: true,
    });
    expect(presentation.description).toContain('MapView kurulamadı');
    expect(presentation.actions).toEqual([
      { id: 'retry-workspace', label: 'Haritayı yeniden başlat', emphasis: 'primary' },
      { id: 'open-help', label: 'Çalışma rehberini aç', emphasis: 'secondary' },
    ]);
  });

  it('switches to page reload fallback only after retry budget is exhausted', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 2 });
    model.beginAttempt();
    model.markError('first');
    model.beginAttempt();
    model.markError('second');
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({
      tone: 'danger',
      attemptLabel: 'Deneme 2 / 2',
      description: expect.stringContaining('Güvenli yeniden başlatma denemeleri tamamlandı'),
    });
    expect(presentation.actions).toEqual([
      { id: 'reload-page', label: 'Sayfayı yenile', emphasis: 'primary' },
      { id: 'open-help', label: 'Çalışma rehberini aç', emphasis: 'secondary' },
    ]);
    expect(presentation.actions.some((action) => action.id === 'retry-workspace')).toBe(false);
  });

  it('never offers page reload while bounded retry remains available', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 3 });
    model.beginAttempt();
    model.markError('first');
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation.actions.some((action) => action.id === 'reload-page')).toBe(false);
    expect(presentation.actions.some((action) => action.id === 'retry-workspace')).toBe(true);
  });

  it('keeps fatal resource rows explicit without duplicating secret objects', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError({ token: 'secret-value' });
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation.resources[0]).toMatchObject({
      key: 'map-view',
      statusLabel: 'Kullanılamıyor',
      tone: 'danger',
      message: null,
    });
    expect(JSON.stringify(presentation)).not.toContain('secret-value');
  });

  it('freezes presentation arrays to prevent consumer mutation', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError('failed');
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.actions)).toBe(true);
    expect(Object.isFrozen(presentation.resources)).toBe(true);
    expect(presentation.resources.every((row) => Object.isFrozen(row))).toBe(true);
  });
});
