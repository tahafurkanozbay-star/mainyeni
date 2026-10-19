import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachKentRehberiGeoJsonLayer } from '../../data-services/kentRehberiGeoJsonLayer';
import { KentRehberiDataLayer } from './KentRehberiDataLayer';
import { setKentRehberiMapFilter } from '../../shell/kentRehberiMapFilter';

vi.mock('../../data-services/kentRehberiGeoJsonLayer', () => ({ attachKentRehberiGeoJsonLayer: vi.fn() }));
const attach = vi.mocked(attachKentRehberiGeoJsonLayer);
const map = { add: vi.fn(), remove: vi.fn() };

beforeEach(() => { vi.resetAllMocks(); setKentRehberiMapFilter(null); });

describe('primary city data layer', () => {
  it('announces real loaded records and releases its handle on unmount', async () => {
    const dispose = vi.fn();
    attach.mockResolvedValue({ layer: {}, featureCount: 12, dispose });
    const { unmount } = render(<KentRehberiDataLayer map={map} />);
    expect(screen.getByRole('status')).toHaveTextContent('Kent verileri haritaya yükleniyor');
    expect(await screen.findByText('12 kent kaydı haritaya yüklendi.')).toBeInTheDocument();
    expect(attach).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ map, signal: expect.any(AbortSignal) }));
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('applies the shared sidebar filter to the loaded overview layer', async () => {
    const layer: { definitionExpression?: string | null } = {};
    attach.mockResolvedValue({ layer, featureCount: 12, dispose: vi.fn() });
    render(<KentRehberiDataLayer map={map} />);
    await screen.findByText('12 kent kaydı haritaya yüklendi.');

    act(() => setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] }));
    expect(layer.definitionExpression).toBe("iconKey IN ('parklar')");

    act(() => setKentRehberiMapFilter(null));
    expect(layer.definitionExpression).toBeNull();
  });

  it('offers bounded retries after a failed load without reflecting server error details', async () => {
    attach.mockRejectedValue(new Error('private upstream password'));
    render(<KentRehberiDataLayer map={map} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Kent verilerini yeniden yükle' }));
    await user.click(await screen.findByRole('button', { name: 'Kent verilerini yeniden yükle' }));
    expect(await screen.findByText(/Yeniden deneme sınırına ulaşıldı/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(attach).toHaveBeenCalledTimes(3);
    expect(document.body).not.toHaveTextContent('private upstream password');
  });

  it('cancels and disposes a late result after unmount', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof attach>>) => void;
    attach.mockImplementation(() => new Promise((complete) => { resolve = complete; }));
    const { unmount } = render(<KentRehberiDataLayer map={map} />);
    await act(async () => { await Promise.resolve(); });
    const signal = attach.mock.calls[0]?.[0].signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    const dispose = vi.fn();
    await act(async () => { resolve({ layer: {}, featureCount: 1, dispose }); });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps exactly one active data handle through React strict effect replay', async () => {
    const dispose = vi.fn();
    attach.mockResolvedValue({ layer: {}, featureCount: 1, dispose });
    const { unmount } = render(<StrictMode><KentRehberiDataLayer map={map} /></StrictMode>);
    await screen.findByText('1 kent kaydı haritaya yüklendi.');
    expect(attach).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
