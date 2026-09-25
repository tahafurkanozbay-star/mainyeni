import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRuntimeRecoveryModel } from '../../experience/runtimeRecoveryModel';
import { ExperienceRuntimeRecoveryBoundary } from './ExperienceRuntimeRecoveryBoundary';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

const ThrowingChild = ({ message = 'render failed' }: { readonly message?: string }) => {
  throw Object.assign(new Error(message), { code: 'UI_RENDER_TEST' });
};

describe('ExperienceRuntimeRecoveryBoundary', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders healthy children without a recovery surface', () => {
    const model = createRuntimeRecoveryModel();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model}>
        <div>Harita arayüzü</div>
      </ExperienceRuntimeRecoveryBoundary>,
    );

    expect(screen.getByText('Harita arayüzü')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('catches render failures and exposes a safe recovery action', () => {
    const model = createRuntimeRecoveryModel();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model}>
        <ThrowingChild />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Arayüz güvenli moda alındı' })).toBeInTheDocument();
    expect(screen.getByText('UI_RENDER_TEST')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arayüzü yeniden kur' })).toBeInTheDocument();
    expect(model.snapshot().failure?.fingerprint).toMatch(/^UI-[a-f0-9]{8}$/);
  });

  test('does not expose raw stack paths in the recovery surface', () => {
    const model = createRuntimeRecoveryModel();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model}>
        <ThrowingChild message="absolute /secret/path should not render" />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    expect(screen.queryByText(/secret\/path/)).not.toBeInTheDocument();
    expect(screen.getByText(/Olay referansı/)).toBeInTheDocument();
  });

  test('focuses the primary recovery action after a crash', () => {
    const model = createRuntimeRecoveryModel();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model}>
        <ThrowingChild />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Arayüzü yeniden kur' }));
  });

  test('recovers by remounting the child tree once', () => {
    const model = createRuntimeRecoveryModel();
    const recovered = vi.fn();
    let shouldThrow = true;

    const Child = () => {
      if (shouldThrow) throw new Error('first render fails');
      return <div>Kurtarılan arayüz</div>;
    };

    render(
      <ExperienceRuntimeRecoveryBoundary model={model} onRecovered={recovered}>
        <Child />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Arayüzü yeniden kur' }));

    expect(screen.getByText('Kurtarılan arayüz')).toBeInTheDocument();
    expect(model.snapshot().phase).toBe('healthy');
    expect(model.snapshot().recoveryAttempts).toBe(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  test('locks recovery after repeated failures and offers reload', () => {
    const model = createRuntimeRecoveryModel({ maxRecoveryAttempts: 1 });
    const reload = vi.fn();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model} onReload={reload}>
        <ThrowingChild />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Arayüzü yeniden kur' }));

    expect(model.snapshot().phase).toBe('locked');
    expect(screen.getByRole('heading', { name: 'Güvenli kurtarma sınırına ulaşıldı' })).toBeInTheDocument();
    const reloadButton = screen.getByRole('button', { name: 'Sayfayı güvenli yenile' });
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('allows manual reload before the recovery budget is exhausted', () => {
    const model = createRuntimeRecoveryModel();
    const reload = vi.fn();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model} onReload={reload}>
        <ThrowingChild />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sayfayı yenile' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('reflects externally captured failures', () => {
    const model = createRuntimeRecoveryModel();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model}>
        <div>healthy</div>
      </ExperienceRuntimeRecoveryBoundary>,
    );

    act(() => {
      model.capture({ error: new Error('external failure'), source: 'workspace.external' });
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('healthy')).not.toBeInTheDocument();
  });

  test('keeps recovery reference bounded and non-empty', () => {
    const model = createRuntimeRecoveryModel();

    render(
      <ExperienceRuntimeRecoveryBoundary model={model}>
        <ThrowingChild />
      </ExperienceRuntimeRecoveryBoundary>,
    );

    const fingerprint = model.snapshot().failure?.fingerprint ?? '';
    expect(fingerprint.length).toBeLessThanOrEqual(11);
    expect(screen.getAllByText(fingerprint).length).toBeGreaterThanOrEqual(1);
  });
});
