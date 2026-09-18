import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  MapWidgetEmptyState,
  MapWidgetSection,
  MapWidgetSkeleton,
  MapWidgetStatus,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from './MapWidgetSurface';

const createManager = (
  overrides: Partial<MapWidgetManagerLike> = {},
): MapWidgetManagerLike => ({
  IsVisible: vi.fn(() => true),
  IsMinimized: vi.fn(() => false),
  ToggleMinimiseWindow: vi.fn(),
  HideWindow: vi.fn(),
  ShowWindow: vi.fn(),
  ShowMessage: vi.fn(),
  RegisterWindow: vi.fn(),
  UnregisterWindow: vi.fn(),
  ...overrides,
});

describe('MapWidgetSurface', () => {
  it('exposes title, busy state and status through semantic attributes', () => {
    const manager = createManager();

    render(
      <MapWidgetSurface
        id="test-widget"
        title="Test aracı"
        windowManager={manager}
        busy
        status="İçerik hazırlanıyor"
        statusTone="info"
        showWindowTools={false}
      >
        <p>Gövde</p>
      </MapWidgetSurface>,
    );

    const region = screen.getByRole('region', { name: 'Test aracı' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('data-widget-visible', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('İçerik hazırlanıyor');
    expect(screen.getByText('Gövde')).toBeVisible();
  });

  it('marks an invisible managed widget as hidden without removing its DOM state', () => {
    const manager = createManager({
      IsVisible: vi.fn(() => false),
    });

    render(
      <MapWidgetSurface
        id="hidden-widget"
        title="Gizli araç"
        windowManager={manager}
        showWindowTools={false}
      >
        <input aria-label="Korunan alan" defaultValue="persisted" />
      </MapWidgetSurface>,
    );

    const region = screen.getByRole('region', { name: 'Gizli araç', hidden: true });
    const preservedInput = region.querySelector<HTMLInputElement>('input[aria-label="Korunan alan"]');
    expect(region).toHaveAttribute('aria-hidden', 'true');
    expect(region).toHaveStyle({ visibility: 'hidden' });
    expect(preservedInput).not.toBeNull();
    expect(preservedInput).toHaveValue('persisted');
  });

  it('renders failures as assertive alerts while keeping informational status separate', () => {
    const manager = createManager();
    render(
      <MapWidgetSurface
        id="error-widget"
        title="Hata aracı"
        windowManager={manager}
        status="Önceki veri korunuyor"
        error="Yeni veri alınamadı"
        showWindowTools={false}
      >
        <div />
      </MapWidgetSurface>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Yeni veri alınamadı');
    expect(screen.getByRole('status')).toHaveTextContent('Önceki veri korunuyor');
  });

  it('supports a dialog role for modal-like map surfaces', () => {
    const manager = createManager();
    render(
      <MapWidgetSurface
        id="dialog-widget"
        title="Detay"
        windowManager={manager}
        role="dialog"
        showWindowTools={false}
      >
        <p>Detay içeriği</p>
      </MapWidgetSurface>,
    );

    expect(screen.getByRole('dialog', { name: 'Detay' })).toBeInTheDocument();
  });

  it('wires the shared minimize and close controls to the window manager', async () => {
    const user = userEvent.setup();
    const manager = createManager();

    render(
      <MapWidgetSurface id="tools-widget" title="Araçlar" windowManager={manager}>
        <p>İçerik</p>
      </MapWidgetSurface>,
    );

    await user.click(screen.getByRole('button', { name: 'Pencereyi küçült' }));
    await user.click(screen.getByRole('button', { name: 'Pencereyi kapat' }));

    expect(manager.ToggleMinimiseWindow).toHaveBeenCalledWith('tools-widget');
    expect(manager.HideWindow).toHaveBeenCalledWith('tools-widget');
  });

  it('preserves custom body and surface class names for gradual legacy migration', () => {
    const manager = createManager();

    render(
      <MapWidgetSurface
        id="compat-widget"
        title="Uyumluluk"
        windowManager={manager}
        className="legacy-shell-hook"
        bodyClassName="legacy-body-hook"
        showWindowTools={false}
      >
        <p>Uyumlu içerik</p>
      </MapWidgetSurface>,
    );

    expect(screen.getByRole('region', { name: 'Uyumluluk' }))
      .toHaveClass('map-widget-surface', 'legacy-shell-hook');
    expect(screen.getByText('Uyumlu içerik').parentElement)
      .toHaveClass('map-widget-surface__body', 'legacy-body-hook');
  });
});

describe('MapWidgetSurface primitives', () => {
  it('renders an empty state with optional recovery action', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();

    render(
      <MapWidgetEmptyState
        title="Veri bulunamadı"
        description="Filtreleri değiştirip yeniden deneyin."
        action={<button type="button" onClick={retry}>Yeniden dene</button>}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Veri bulunamadı');
    await user.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('bounds skeleton rows to avoid accidental DOM explosions', () => {
    const { rerender } = render(<MapWidgetSkeleton rows={1000} />);
    expect(screen.getByRole('status').children).toHaveLength(12);

    rerender(<MapWidgetSkeleton rows={0} />);
    expect(screen.getByRole('status').children).toHaveLength(1);
  });

  it('lets sections carry headings, descriptions and action controls', async () => {
    const user = userEvent.setup();
    const action = vi.fn();

    render(
      <MapWidgetSection
        title="Katman ayarları"
        description="Görünürlük ve sunum seçenekleri"
        actions={<button type="button" onClick={action}>Sıfırla</button>}
      >
        <label>
          Opaklık
          <input type="range" aria-label="Opaklık" />
        </label>
      </MapWidgetSection>,
    );

    expect(screen.getByRole('heading', { name: 'Katman ayarları' })).toBeInTheDocument();
    expect(screen.getByText('Görünürlük ve sunum seçenekleri')).toBeInTheDocument();
    expect(screen.getByLabelText('Opaklık')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sıfırla' }));
    expect(action).toHaveBeenCalledOnce();
  });

  it('selects semantic live-region behavior from tone', () => {
    const { rerender } = render(<MapWidgetStatus tone="info">Hazır</MapWidgetStatus>);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    rerender(<MapWidgetStatus tone="danger">Başarısız</MapWidgetStatus>);
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });
});
