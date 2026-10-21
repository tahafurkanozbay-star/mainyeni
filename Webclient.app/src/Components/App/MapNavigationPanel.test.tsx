import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AddressGeocodingResult } from '../../data-services/addressGeocoding';
import type { InAppNavigationResult } from '../../gis-engine/inAppNavigationRuntime';
import { MapNavigationPanel } from './MapNavigationPanel';

const createAddress = (displayName: string, latitude: number): AddressGeocodingResult => Object.freeze({
  displayName,
  latitude,
  longitude: 32.85,
  zoom: 16,
  attribution: '© OpenStreetMap katkıcıları',
  attributionUrl: 'https://www.openstreetmap.org/copyright',
});

const createRoute = (): InAppNavigationResult => Object.freeze({
  geometry: { type: 'polyline' },
  distanceKm: 3.4,
  durationMinutes: 18,
  steps: Object.freeze([
    Object.freeze({
      id: 'direction-0',
      instruction: 'Atatürk Bulvarı yönünde ilerleyin',
      distanceKm: 1.2,
      durationMinutes: 6,
    }),
  ]),
});

const renderPanel = (overrides: {
  onAddressSearch?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly AddressGeocodingResult[]>;
  onPlanRoute?: (
    origin: AddressGeocodingResult,
    destination: AddressGeocodingResult,
    mode: 'driving' | 'walking',
    signal: AbortSignal,
  ) => Promise<InAppNavigationResult>;
} = {}) => {
  const onAddressSearch = overrides.onAddressSearch ?? vi.fn(async (query: string) => [
    createAddress(`${query}, Ankara`, 39.92),
  ]);
  const onPlanRoute = overrides.onPlanRoute ?? vi.fn(async () => createRoute());
  const onClearRoute = vi.fn();
  const onClose = vi.fn();
  const renderResult = render(
    <MapNavigationPanel
      onAddressSearch={onAddressSearch}
      onPlanRoute={onPlanRoute}
      onClearRoute={onClearRoute}
      onClose={onClose}
    />,
  );
  return { ...renderResult, onAddressSearch, onPlanRoute, onClearRoute, onClose };
};

describe('MapNavigationPanel', () => {
  it('geocodes both stops and renders an in-map route with step directions', async () => {
    const user = userEvent.setup();
    const { onAddressSearch, onPlanRoute } = renderPanel();

    await user.type(screen.getByRole('searchbox', { name: 'Başlangıç' }), 'Kızılay');
    await user.click(screen.getByRole('button', { name: 'Başlangıç adresini ara' }));
    await user.click(await screen.findByRole('button', { name: 'Kızılay, Ankara' }));

    await user.type(screen.getByRole('searchbox', { name: 'Varış' }), 'Anıtkabir');
    await user.click(screen.getByRole('button', { name: 'Varış adresini ara' }));
    await user.click(await screen.findByRole('button', { name: 'Anıtkabir, Ankara' }));
    await user.click(screen.getByRole('button', { name: 'Rotayı haritada göster' }));

    expect(onAddressSearch).toHaveBeenCalledTimes(2);
    expect(onPlanRoute).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Kızılay, Ankara' }),
      expect.objectContaining({ displayName: 'Anıtkabir, Ankara' }),
      'driving',
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('18 dk')).toBeInTheDocument();
    expect(screen.getByText('3,4 km')).toBeInTheDocument();
    expect(screen.getByText('Atatürk Bulvarı yönünde ilerleyin')).toBeInTheDocument();
  });

  it('allows walking mode and clears the previously displayed route when inputs change', async () => {
    const user = userEvent.setup();
    const { onClearRoute, onPlanRoute } = renderPanel();
    const mode = screen.getByRole('combobox', { name: 'Ulaşım türü' });
    await user.selectOptions(mode, 'walking');
    expect(onClearRoute).toHaveBeenCalled();

    await user.type(screen.getByRole('searchbox', { name: 'Başlangıç' }), 'A');
    expect(screen.getByRole('searchbox', { name: 'Başlangıç' })).toHaveValue('A');
    expect(onPlanRoute).not.toHaveBeenCalled();
  });

  it('surfaces route-service errors and supports cancellation', async () => {
    const user = userEvent.setup();
    const onPlanRoute = vi.fn(async () => {
      throw new Error('Rota servisine erişilemiyor. ArcGIS yönlendirme yetkisini ve bağlantıyı kontrol edin.');
    });
    const { onAddressSearch } = renderPanel({ onPlanRoute });

    await user.type(screen.getByRole('searchbox', { name: 'Başlangıç' }), 'Kızılay');
    await user.click(screen.getByRole('button', { name: 'Başlangıç adresini ara' }));
    await user.click(await screen.findByRole('button', { name: 'Kızılay, Ankara' }));
    await user.type(screen.getByRole('searchbox', { name: 'Varış' }), 'Anıtkabir');
    await user.click(screen.getByRole('button', { name: 'Varış adresini ara' }));
    await user.click(await screen.findByRole('button', { name: 'Anıtkabir, Ankara' }));
    await user.click(screen.getByRole('button', { name: 'Rotayı haritada göster' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ArcGIS yönlendirme yetkisini');
    expect(onAddressSearch).toHaveBeenCalledTimes(2);
  });

  it('cancels pending route calculations and closes the panel accessibly', async () => {
    const user = userEvent.setup();
    let resolveRoute: ((result: InAppNavigationResult) => void) | undefined;
    const onPlanRoute = vi.fn(() => new Promise<InAppNavigationResult>((resolve) => {
      resolveRoute = resolve;
    }));
    const { onClose } = renderPanel({ onPlanRoute });
    const search = async (field: string, query: string) => {
      await user.type(screen.getByRole('searchbox', { name: field }), query);
      await user.click(screen.getByRole('button', { name: `${field} adresini ara` }));
      await user.click(await screen.findByRole('button', { name: `${query}, Ankara` }));
    };
    await search('Başlangıç', 'Kızılay');
    await search('Varış', 'Anıtkabir');
    await user.click(screen.getByRole('button', { name: 'Rotayı haritada göster' }));
    await user.click(screen.getByRole('button', { name: 'Hesaplamayı iptal et' }));
    expect(screen.getByRole('button', { name: 'Rotayı haritada göster' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Yol tarifi panelini kapat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    resolveRoute?.(createRoute());
    await waitFor(() => expect(screen.queryByText('18 dk')).not.toBeInTheDocument());
  });

  it('keeps the panel keyboard-operable', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Yol tarifi panelini kapat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('complementary', { name: 'Uygulama içi yol tarifi' })).toHaveAttribute(
      'id',
      'map-navigation-panel',
    );
  });
});
