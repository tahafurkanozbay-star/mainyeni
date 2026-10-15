import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedFastAccessQueryWindow, type ManagedWindowHandle } from './ManagedFastAccessQueryWindow';
import { Constants_ServiceResultType } from '../../../Core/Constants';

const ports = vi.hoisted(() => ({
  layer: vi.fn(), log: vi.fn(), getMap: vi.fn(), zoom: vi.fn(),
}));
vi.mock('../../../Business/CommonBusiness', () => ({
  CommonBusiness: { Clustering: { CreateLayerWithoutClustering: ports.layer } },
}));
vi.mock('../../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: ports.log } }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: ports.getMap } }));
vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({ GisGraphicsHelper: { ZoomToGeometry: ports.zoom } }));
vi.mock('../../../gis-engine/iconPresentation', () => ({ createPictureMarkerSymbol: () => ({ type: 'picture-marker' }) }));
vi.mock('../../Common/SharedGISIcon', () => ({ SharedGISIcon: () => <span aria-hidden="true" /> }));

const response = (count: number) => ({
  type: Constants_ServiceResultType.Success,
  data: Array.from({ length: count }, (_, index) => ({
    attr: { OBJECTID: index, ADI: 'Park ' + index, ADRES: 'Ankara' },
    geometry: { x: 32.85, y: 39.92 },
  })),
});

const setup = async (count: number) => {
  const query = vi.fn(async () => response(count));
  const manager = {
    RegisterWindow: vi.fn(), GetQueryParams: () => ({}), ShowMessage: vi.fn(),
    ShowWindow: vi.fn(), ToggleMinimiseWindow: vi.fn(),
  };
  const Component = createManagedFastAccessQueryWindow({
    title: 'Parklar', serviceKey: 'parks', pageSize: 10, business: { Query: query },
  });
  const ref = createRef<ManagedWindowHandle>();
  render(<Component id="paging-focus" windowManager={manager} ref={ref} />);
  await act(async () => { await ref.current?.OnShow(); });
  return { query, ref };
};

const captureFrames = () => {
  const callbacks: FrameRequestCallback[] = [];
  const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return {
    flush: () => act(() => { callbacks.splice(0).forEach((callback) => callback(0)); }),
    restore: () => spy.mockRestore(),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  ports.log.mockResolvedValue(undefined);
  ports.layer.mockResolvedValue({
    layerObj: { destroy: vi.fn(), queryExtent: vi.fn(async () => ({ extent: null })) },
  });
  ports.getMap.mockReturnValue({ map: { add: vi.fn(), remove: vi.fn() }, zoom: 12 });
});

describe('FastAccess result paging focus ownership', () => {
  it('moves keyboard focus to the newly appended result without a new query', async () => {
    const view = await setup(100);
    const frames = captureFrames();
    try {
      const reveal = screen.getByRole('button', { name: /Daha fazla sonuç göster/ });
      reveal.focus();
      fireEvent.click(reveal, { detail: 0 });
      frames.flush();
      expect(screen.getByRole('button', { name: 'Park 10 — Haritada göster' })).toHaveFocus();
      expect(view.query).toHaveBeenCalledOnce();
    } finally {
      frames.restore();
    }
  });

  it('does not reclaim focus from a pointer-triggered reveal', async () => {
    const view = await setup(100);
    const frames = captureFrames();
    try {
      const filter = screen.getByRole('searchbox');
      filter.focus();
      fireEvent.click(screen.getByRole('button', { name: /Daha fazla sonuç göster/ }), { detail: 1 });
      frames.flush();
      expect(filter).toHaveFocus();
      expect(screen.getAllByRole('listitem')).toHaveLength(20);
      expect(view.query).toHaveBeenCalledOnce();
    } finally {
      frames.restore();
    }
  });

  it('moves keyboard focus to the first record in the next bounded group', async () => {
    const view = await setup(201);
    const reveal = screen.getByRole('button', { name: /Daha fazla sonuç göster/ });
    for (let batch = 0; batch < 19; batch += 1) {
      fireEvent.click(reveal, { detail: 1 });
    }
    expect(screen.getByRole('list', { name: 'Parklar sonuçları' }).querySelectorAll('li')).toHaveLength(200);
    const frames = captureFrames();
    try {
      const next = screen.getByRole('button', { name: 'Sonraki sonuçlara geç' });
      next.focus();
      fireEvent.click(next, { detail: 0 });
      frames.flush();
      expect(screen.getByRole('button', { name: 'Park 200 — Haritada göster' })).toHaveFocus();
      expect(view.query).toHaveBeenCalledOnce();
    } finally {
      frames.restore();
    }
  });
});
