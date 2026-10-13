import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { StreetViewWidget } from './StreetViewWidget';
const getClick = vi.hoisted(() => vi.fn());
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapClickEvent: getClick } }));
const manager = () => ({ IsVisible: vi.fn(() => true), IsMinimized: vi.fn(() => false), ShowWindow: vi.fn(), RegisterWindow: vi.fn(), UnregisterWindow: vi.fn(), HideWindow: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowMessage: vi.fn() });
const setup = () => { const ref = createRef<ManagedWindowHandle>(); const windowManager = manager(); return { ...render(<StreetViewWidget id="streetview-test" windowManager={windowManager} ref={ref} />), ref, windowManager }; };
beforeEach(() => { getClick.mockReset(); getClick.mockReturnValue({ mapPoint: { latitude: 39.92, longitude: 32.854 } }); });
describe('street view location launch', () => {
  it('shows instructions without claiming imagery before a point is selected', () => { setup(); expect(screen.getByText('Konum seçin')).toBeVisible(); expect(screen.queryByRole('link')).toBeNull(); });
  it('opens the normalized location through the official panorama URL and has no automatic iframe request', async () => {
    const { ref, container } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    const link = screen.getByRole('link', { name: /Sokak görüntüsünü aç/ }); const url = new URL(link.getAttribute('href')!);
    expect(url.origin).toBe('https://www.google.com'); expect(url.searchParams.get('api')).toBe('1'); expect(url.searchParams.get('map_action')).toBe('pano'); expect(url.searchParams.get('viewpoint')).toBe('39.92,32.854');
    expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('iframe')).toBeNull(); expect(screen.getByText('39.92000')).toBeVisible();
  });
  it('accepts legacy numeric xy input through the shared point normalizer', async () => {
    getClick.mockReturnValue({ mapPoint: { y: '39.92', x: '32.854' } });
    const { ref } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    expect(screen.getByRole('link', { name: /Sokak görüntüsünü aç/ })).toHaveAttribute('href', expect.stringContaining('viewpoint=39.92%2C32.854'));
  });
  it.each([null, { mapPoint: null }, { mapPoint: { latitude: 91, longitude: 32 } }, { mapPoint: { latitude: 39, longitude: Number.NaN } }])('keeps invalid clicks actionable without launching a provider: %j', async event => {
    getClick.mockReturnValue(event); const { ref } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    expect(screen.getByText('Konum seçin')).toBeVisible(); expect(screen.queryByRole('link')).toBeNull();
  });
  it('retains the selected snapshot through minimize and clears it on close', async () => {
    const { ref, windowManager, rerender } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    windowManager.IsMinimized.mockReturnValue(true); rerender(<StreetViewWidget id="streetview-test" windowManager={windowManager} ref={ref} />);
    expect(screen.queryByRole('link')).toBeNull(); windowManager.IsMinimized.mockReturnValue(false); rerender(<StreetViewWidget id="streetview-test" windowManager={windowManager} ref={ref} />);
    expect(screen.getByText('39.92000')).toBeVisible(); await act(async () => { ref.current?.OnClose?.(); }); expect(screen.queryByRole('link')).toBeNull();
  });
});
