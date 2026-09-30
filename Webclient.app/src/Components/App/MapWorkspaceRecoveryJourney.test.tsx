import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import { MapWorkspaceHealthSurface } from './MapWorkspaceHealthSurface';
import { createMapWorkspaceRecoveryFocusController } from './mapWorkspaceRecoveryFocus';

interface JourneyHarnessProps {
  readonly model: MapWorkspaceAccessibilityModel;
  readonly onOpenHelp?: () => void;
  readonly onReload?: () => void;
}

const JourneyHarness = ({ model, onOpenHelp, onReload }: JourneyHarnessProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusControllerRef = useRef<ReturnType<typeof createMapWorkspaceRecoveryFocusController> | null>(null);
  if (!focusControllerRef.current) {
    focusControllerRef.current = createMapWorkspaceRecoveryFocusController({
      getTarget: () => rootRef.current,
    });
  }
  const focusController = focusControllerRef.current;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    focusController.sync(snapshot);
  }, [focusController, snapshot]);

  useEffect(() => () => focusController.dispose(), [focusController]);

  const retry = (): void => {
    if (!model.getSnapshot().canRetry) return;
    focusController.requestRestore();
    model.beginAttempt();
    setGeneration((current) => current + 1);
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="workspace-root"
      data-generation={generation}
      data-phase={snapshot.phase}
    >
      <MapWorkspaceHealthSurface
        model={model}
        onRetry={retry}
        onOpenHelp={onOpenHelp}
        onReloadPage={onReload}
      />
    </div>
  );
};

const failFirstAttempt = (model: MapWorkspaceAccessibilityModel, message = 'MapView kurulamadı'): void => {
  act(() => {
    model.beginAttempt();
    model.markError(new Error(message));
  });
};

describe('workspace operational recovery journey', () => {
  it('moves from fatal failure to bounded retry boot and restores focus only after ready', () => {
    const model = new MapWorkspaceAccessibilityModel();
    failFirstAttempt(model);
    render(<JourneyHarness model={model} />);

    const root = screen.getByTestId('workspace-root');
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    expect(root).toHaveAttribute('data-generation', '1');
    expect(root).toHaveAttribute('data-phase', 'booting');
    expect(document.activeElement).toBe(outside);

    act(() => { model.markReady(); });
    expect(root).toHaveAttribute('data-phase', 'ready');
    expect(document.activeElement).toBe(root);
    expect(screen.queryByRole('heading', { name: /harita çalışma alanı/i })).not.toBeInTheDocument();
    outside.remove();
  });

  it('restores focus after a retry that reaches degraded-but-interactive state', () => {
    const model = new MapWorkspaceAccessibilityModel();
    failFirstAttempt(model);
    render(<JourneyHarness model={model} />);
    const root = screen.getByTestId('workspace-root');

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    act(() => {
      model.markReady();
      model.markResourceFailed('kent-rehberi-data', 'Veri katmanı geçici olarak yok');
    });

    expect(root).toHaveAttribute('data-phase', 'degraded');
    expect(document.activeElement).toBe(root);
    expect(screen.getByRole('heading', { name: 'Harita sınırlı özelliklerle çalışıyor' })).toBeInTheDocument();
    expect(screen.getByText('1 sınırlama')).toBeInTheDocument();
  });

  it('does not restore focus during retry boot before interactivity returns', () => {
    const model = new MapWorkspaceAccessibilityModel();
    failFirstAttempt(model);
    render(<JourneyHarness model={model} />);
    const root = screen.getByTestId('workspace-root');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    expect(model.getSnapshot().phase).toBe('booting');
    expect(document.activeElement).toBe(outside);
    expect(document.activeElement).not.toBe(root);
    outside.remove();
  });

  it('keeps focus restoration one-shot across later updating transitions', () => {
    const model = new MapWorkspaceAccessibilityModel();
    failFirstAttempt(model);
    render(<JourneyHarness model={model} />);
    const root = screen.getByTestId('workspace-root');
    const focusSpy = vi.spyOn(root, 'focus');

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    act(() => { model.markReady(); });
    expect(focusSpy).toHaveBeenCalledTimes(1);

    act(() => {
      model.markUpdating(true);
      model.markUpdating(false);
      model.markResourceLoading('kent-rehberi-data');
      model.markResourceReady('kent-rehberi-data');
    });
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves a usable help action while a retry is still available', () => {
    const onOpenHelp = vi.fn();
    const model = new MapWorkspaceAccessibilityModel();
    failFirstAttempt(model);
    render(<JourneyHarness model={model} onOpenHelp={onOpenHelp} />);

    expect(screen.getByRole('button', { name: 'Haritayı yeniden başlat' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma rehberini aç' }));
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', attempt: 1, canRetry: true });
  });

  it('moves to reload fallback only after the configured recovery budget is exhausted', () => {
    const onReload = vi.fn();
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 2 });
    failFirstAttempt(model, 'first');
    render(<JourneyHarness model={model} onReload={onReload} />);

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    act(() => { model.markError(new Error('second')); });

    expect(model.getSnapshot()).toMatchObject({ attempt: 2, retryExhausted: true, canRetry: false });
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sayfayı yenile' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('does not consume a retry when the user opens help', () => {
    const onOpenHelp = vi.fn();
    const model = new MapWorkspaceAccessibilityModel();
    failFirstAttempt(model);
    render(<JourneyHarness model={model} onOpenHelp={onOpenHelp} />);

    const before = model.getSnapshot();
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma rehberini aç' }));
    const after = model.getSnapshot();
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
    expect(after.attempt).toBe(before.attempt);
    expect(after.revision).toBe(before.revision);
  });

  it('turns optional data loss into a degraded journey without exposing fatal retry controls', () => {
    const model = new MapWorkspaceAccessibilityModel();
    act(() => {
      model.beginAttempt();
      model.markReady();
      model.markResourceLoading('kent-rehberi-data');
      model.markResourceFailed('kent-rehberi-data', new Error('Katman geçici olarak yok'));
    });
    render(<JourneyHarness model={model} />);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'degraded',
      isInteractive: true,
      canRetry: false,
      issueCount: 1,
    });
    expect(screen.getByRole('heading', { name: 'Harita sınırlı özelliklerle çalışıyor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sayfayı yenile' })).not.toBeInTheDocument();
  });

  it('returns from degraded to visually quiet healthy state after data recovers', () => {
    const model = new MapWorkspaceAccessibilityModel();
    act(() => {
      model.beginAttempt();
      model.markReady();
      model.markResourceFailed('kent-rehberi-data', 'temporary');
    });
    render(<JourneyHarness model={model} />);
    expect(screen.getByRole('heading', { name: 'Harita sınırlı özelliklerle çalışıyor' })).toBeInTheDocument();

    act(() => { model.markResourceReady('kent-rehberi-data'); });
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', health: 'healthy', issueCount: 0 });
    expect(screen.queryByRole('heading', { name: 'Harita sınırlı özelliklerle çalışıyor' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Harita çalışma alanı kullanıma hazır.');
  });

  it('keeps fatal raw object data out of the rendered recovery journey', () => {
    const model = new MapWorkspaceAccessibilityModel();
    act(() => {
      model.beginAttempt();
      model.markError({ token: 'secret-token-value', endpoint: 'private-host' });
    });
    render(<JourneyHarness model={model} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Harita çalışma alanı hazırlanamadı.');
    expect(document.body.textContent).not.toContain('secret-token-value');
    expect(document.body.textContent).not.toContain('private-host');
  });

  it('keeps delayed boot recoverable through help but not premature retry', () => {
    let delayed: (() => void) | undefined;
    const onOpenHelp = vi.fn();
    const model = new MapWorkspaceAccessibilityModel({
      scheduleTimeout(callback) {
        delayed = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout() {},
    });
    act(() => { model.beginAttempt(); });
    render(<JourneyHarness model={model} onOpenHelp={onOpenHelp} />);
    act(() => { delayed?.(); });

    expect(screen.getByRole('heading', { name: 'Harita hazırlanıyor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma rehberini aç' }));
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });

  it('keeps delayed update interactive and does not arm recovery focus', () => {
    let delayed: (() => void) | undefined;
    const model = new MapWorkspaceAccessibilityModel({
      scheduleTimeout(callback) {
        delayed = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout() {},
    });
    act(() => {
      model.beginAttempt();
      model.markReady();
      model.markUpdating(true);
    });
    render(<JourneyHarness model={model} />);
    act(() => { delayed?.(); });

    expect(model.getSnapshot()).toMatchObject({ phase: 'updating', isInteractive: true, isDelayed: true });
    expect(screen.getByRole('heading', { name: 'Harita güncellemesi sürüyor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
  });

  it('keeps recent operational details available during degraded recovery', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxEvents: 6 });
    act(() => {
      model.beginAttempt();
      model.markReady();
      model.markResourceLoading('kent-rehberi-data');
      model.markResourceFailed('kent-rehberi-data', 'temporary');
    });
    render(<JourneyHarness model={model} />);

    expect(screen.getByText('Son durum değişiklikleri')).toBeInTheDocument();
    expect(screen.getByText('Kent Rehberi veri katmanı sınırlı.')).toBeInTheDocument();
    expect(model.getSnapshot().recentEvents.length).toBeLessThanOrEqual(6);
  });

  it('keeps retry generation monotonically increasing without exceeding model attempt budget', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 3 });
    failFirstAttempt(model, 'first');
    render(<JourneyHarness model={model} />);
    const root = screen.getByTestId('workspace-root');

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    expect(root).toHaveAttribute('data-generation', '1');
    act(() => { model.markError('second'); });
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    expect(root).toHaveAttribute('data-generation', '2');
    act(() => { model.markError('third'); });

    expect(model.getSnapshot()).toMatchObject({ attempt: 3, retryExhausted: true });
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
  });
});
