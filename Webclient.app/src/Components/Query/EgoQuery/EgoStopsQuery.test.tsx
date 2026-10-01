import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { EgoStopsQuery } from './EgoStopsQuery';

vi.mock('../../../Business/LoggingBusiness', () => ({
  LoggingBusiness: {
    CreateClientLog: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: vi.fn(),
    RemoveGraphics: vi.fn(),
    AddGraphics: vi.fn(),
  },
}));

vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({
  GisGraphicsHelper: {
    CreatePoint: vi.fn(),
    CreateGraphicFromGeometry: vi.fn(),
    ZoomToGeometry: vi.fn(),
  },
}));

const stops = Object.freeze([
  {
    stopNo: '1001',
    stopName: 'Kızılay',
    lineType: 'Merkez',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    stopNo: '1002',
    stopName: 'Ulus',
    lineType: 'Aktarma',
    latitude: 39.9411,
    longitude: 32.8547,
  },
  {
    stopNo: '1003',
    stopName: 'Sıhhiye',
    lineType: 'Durak',
    latitude: 39.9272,
    longitude: 32.8594,
  },
]);

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

const installBrowserFacts = (width = 1280): void => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(pointer: coarse)' ? false : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
};

describe('EgoStopsQuery modern result table', () => {
  beforeEach(() => {
    installBrowserFacts();
    vi.mocked(MapManager.GetMapView).mockReturnValue({} as never);
    vi.mocked(GisGraphicsHelper.CreatePoint).mockResolvedValue({ type: 'point' } as never);
    vi.mocked(GisGraphicsHelper.CreateGraphicFromGeometry).mockResolvedValue({ id: 'graphic' } as never);
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
    vi.clearAllMocks();
  });

  it('renders loading state before stop data exists', () => {
    render(<EgoStopsQuery stops={undefined} showAll />);
    expect(document.querySelector('.container-loading, [aria-busy="true"]')).not.toBeNull();
  });

  it('renders empty state for an empty stop collection', () => {
    render(<EgoStopsQuery stops={[]} showAll />);
    expect(screen.getByText('Aktif durak bulunamadı.')).toBeInTheDocument();
  });

  it('renders stops in the semantic responsive table', () => {
    render(<EgoStopsQuery stops={stops} showAll />);
    expect(screen.getByRole('table', { name: 'EGO durak sonuçları' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Durak no' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Durak adı' })).toBeInTheDocument();
    expect(screen.getByText('Kızılay')).toBeInTheDocument();
    expect(screen.getByLabelText('Durak sonuç sayısı')).toHaveTextContent('3/3');
  });

  it('uses native search without react-bootstrap input wrappers', () => {
    const { container } = render(<EgoStopsQuery stops={stops} showAll />);
    expect(screen.getByRole('searchbox', { name: 'Durak ara' })).toBeInTheDocument();
    expect(container.querySelector('.input-group')).toBeNull();
  });

  it('filters rows and announces the matching count', () => {
    render(<EgoStopsQuery stops={stops} showAll />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Durak ara' }), {
      target: { value: 'Ulus' },
    });
    expect(screen.getByText('Ulus')).toBeInTheDocument();
    expect(screen.queryByText('Kızılay')).not.toBeInTheDocument();
    expect(screen.getByText('1 durak eşleşti')).toBeInTheDocument();
    expect(screen.getByLabelText('Durak sonuç sayısı')).toHaveTextContent('1/3');
  });

  it('clears an active search with a 44px-capable semantic button', () => {
    render(<EgoStopsQuery stops={stops} showAll />);
    const search = screen.getByRole('searchbox', { name: 'Durak ara' });
    fireEvent.change(search, { target: { value: 'Ulus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Temizle' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('Kızılay')).toBeInTheDocument();
  });

  it('shows a useful no-results state after filtering', () => {
    render(<EgoStopsQuery stops={stops} showAll />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Durak ara' }), {
      target: { value: 'olmayan durak' },
    });
    expect(screen.getByText('Aramanızla eşleşen durak bulunamadı.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('activates a table row and displays the stop on the current map', async () => {
    render(<EgoStopsQuery stops={stops} showAll />);
    const row = screen.getByText('Kızılay').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLTableRowElement);
    await waitFor(() => {
      expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledWith({
        latitude: 39.9208,
        longitude: 32.8541,
      });
    });
    expect(GisGraphicsHelper.CreateGraphicFromGeometry).toHaveBeenCalled();
    expect(MapManager.AddGraphics).toHaveBeenCalledWith(expect.anything(), true);
    expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledWith(expect.anything(), expect.anything(), 17);
  });

  it('exposes invalid coordinate failures without attempting geometry creation', async () => {
    const invalidStops = [{
      stopNo: '9999',
      stopName: 'Geçersiz',
      lineType: 'Durak',
      latitude: Number.NaN,
      longitude: 32.8,
    }];
    render(<EgoStopsQuery stops={invalidStops} showAll />);
    fireEvent.click(screen.getByText('Geçersiz').closest('tr') as HTMLTableRowElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('Durak konum bilgisi geçersiz.');
    expect(GisGraphicsHelper.CreatePoint).not.toHaveBeenCalled();
  });

  it('reports missing map view without leaking a rejected promise', async () => {
    vi.mocked(MapManager.GetMapView).mockReturnValue(null as never);
    render(<EgoStopsQuery stops={stops} showAll />);
    fireEvent.click(screen.getByText('Ulus').closest('tr') as HTMLTableRowElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('Harita görünümü hazır değil.');
  });

  it('cleans owned graphics when the component unmounts', async () => {
    const { unmount } = render(<EgoStopsQuery stops={stops} showAll />);
    fireEvent.click(screen.getByText('Kızılay').closest('tr') as HTMLTableRowElement);
    await waitFor(() => expect(MapManager.AddGraphics).toHaveBeenCalled());
    unmount();
    expect(MapManager.RemoveGraphics).toHaveBeenCalled();
  });

  it('automatically hides optional type column on narrow phones', () => {
    installBrowserFacts(390);
    render(<EgoStopsQuery stops={stops} showAll />);
    expect(screen.getByRole('columnheader', { name: 'Durak no' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Durak adı' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Tür' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Durak tablosu sütun görünümü')).toHaveTextContent('2/3 sütun');
  });

  it('preserves keyboard row activation through the shared table controller', async () => {
    render(<EgoStopsQuery stops={stops} showAll />);
    const row = screen.getByText('Kızılay').closest('tr') as HTMLTableRowElement;
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledTimes(1));
  });
});
