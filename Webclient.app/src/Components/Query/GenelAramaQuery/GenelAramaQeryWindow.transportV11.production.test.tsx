import { createRef } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FastAccessQuery,
  QueryExecutionControl,
} from '../../../Business/contracts';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
} from '../_Common/QuerySurfaceContracts';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createClientLog: vi.fn(),
  getMapView: vi.fn(),
  zoomToGeometry: vi.fn(),
}));

vi.mock('../../../Business/GenelAramaQeryBusiness', () => ({
  GenelAramaQeryBusiness: Object.freeze({
    Query: mocks.query,
  }),
}));

vi.mock('../../../Business/LoggingBusiness', () => ({
  LoggingBusiness: Object.freeze({
    CreateClientLog: mocks.createClientLog,
  }),
}));

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: Object.freeze({
    GetMapView: mocks.getMapView,
  }),
}));

vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({
  GisGraphicsHelper: Object.freeze({
    ZoomToGeometry: mocks.zoomToGeometry,
  }),
}));

vi.mock('../_Common/CommonQueryResultItemTools', () => ({
  CommonQueryResultItemTools: () => null,
}));

import { GenelAramaQeryWindow } from './GenelAramaQeryWindow';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return Object.freeze({ promise, resolve, reject });
};

const success = (data: readonly unknown[], message = ''): unknown => Object.freeze({
  type: 10,
  data: Object.freeze([...data]),
  message,
});

const failure = (message: string): unknown => Object.freeze({
  type: 20,
  data: Object.freeze([]),
  message,
});

const result = (
  id: number,
  title: string,
  address = 'Ankara',
): Readonly<Record<string, unknown>> => Object.freeze({
  ObjectId: id,
  Title: title,
  Address: address,
  Category: 'Test',
  Type: 'Test Türü',
});

interface ManagerHarness {
  readonly manager: ManagedQueryWindowManager;
  readonly RegisterWindow: ReturnType<typeof vi.fn>;
  readonly UnregisterWindow: ReturnType<typeof vi.fn>;
  readonly ShowWindow: ReturnType<typeof vi.fn>;
  readonly GetQueryParams: ReturnType<typeof vi.fn>;
  readonly IsVisible: ReturnType<typeof vi.fn>;
  readonly IsMinimized: ReturnType<typeof vi.fn>;
  readonly ToggleMinimiseWindow: ReturnType<typeof vi.fn>;
  readonly ShowMessage: ReturnType<typeof vi.fn>;
}

const createManager = (
  queryParams: Readonly<Record<string, unknown>> = Object.freeze({ name: 'park' }),
): ManagerHarness => {
  const RegisterWindow = vi.fn();
  const UnregisterWindow = vi.fn();
  const ShowWindow = vi.fn();
  const GetQueryParams = vi.fn(() => queryParams);
  const IsVisible = vi.fn(() => true);
  const IsMinimized = vi.fn(() => false);
  const ToggleMinimiseWindow = vi.fn();
  const ShowMessage = vi.fn();

  const manager = {
    RegisterWindow,
    UnregisterWindow,
    ShowWindow,
    GetQueryParams,
    IsVisible,
    IsMinimized,
    ToggleMinimiseWindow,
    ShowMessage,
  } as unknown as ManagedQueryWindowManager;

  return Object.freeze({
    manager,
    RegisterWindow,
    UnregisterWindow,
    ShowWindow,
    GetQueryParams,
    IsVisible,
    IsMinimized,
    ToggleMinimiseWindow,
    ShowMessage,
  });
};

const renderWindow = (
  managerHarness = createManager(),
): Readonly<{
  ref: ReturnType<typeof createRef<ManagedQueryWindowHandle>>;
  managerHarness: ManagerHarness;
  unmount: () => void;
}> => {
  const ref = createRef<ManagedQueryWindowHandle>();
  const rendered = render(
    <GenelAramaQeryWindow
      id="general-search-test"
      windowManager={managerHarness.manager}
      ref={ref}
    />,
  );

  return Object.freeze({
    ref,
    managerHarness,
    unmount: rendered.unmount,
  });
};

const runOnShow = async (
  ref: ReturnType<typeof createRef<ManagedQueryWindowHandle>>,
): Promise<void> => {
  await act(async () => {
    await ref.current?.OnShow();
  });
};

const queryControlAt = (callIndex: number): QueryExecutionControl => {
  const call = mocks.query.mock.calls[callIndex] as unknown[] | undefined;
  return (call?.[2] ?? {}) as QueryExecutionControl;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClientLog.mockResolvedValue(undefined);
  mocks.getMapView.mockReturnValue(Object.freeze({ id: 'map-view' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GenelAramaQeryWindow v11 transport integration', () => {
  it('registers the real managed window and executes initial search through owned v11 control', async () => {
    mocks.query.mockResolvedValue(success([
      result(1, 'Kuğulu Park', 'Çankaya Ankara'),
      result(2, 'Gençlik Parkı', 'Altındağ Ankara'),
    ]));
    const harness = renderWindow();

    expect(harness.managerHarness.RegisterWindow).toHaveBeenCalledTimes(1);
    expect(harness.ref.current?.id).toBe('general-search-test');

    await runOnShow(harness.ref);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [query, returnGeometry] = mocks.query.mock.calls[0] ?? [];
    expect(query).toMatchObject({ name: 'park' });
    expect(returnGeometry).toBe(false);

    const control = queryControlAt(0);
    expect(control.signal).toBeInstanceOf(AbortSignal);
    expect(control.signal?.aborted).toBe(false);
    expect(control.timeoutMs).toBe(20_000);
    expect(control.cacheTtlMs).toBe(15_000);
    expect(control.cache).toBe(true);
    expect(control.deduplicate).toBe(false);
    expect(control.requestKey).toContain('genel-arama-v11:search');
    expect(control.requestKey).toContain('general-search-test');

    expect(await screen.findByText('Kuğulu Park')).toBeInTheDocument();
    expect(screen.getByText('Gençlik Parkı')).toBeInTheDocument();
    expect(screen.getByText(/2 sonuç/u)).toBeInTheDocument();
  });

  it('supersedes a previous OnShow request and only renders the newest result set', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.query
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const managerHarness = createManager();
    managerHarness.GetQueryParams
      .mockReturnValueOnce({ name: 'eski' })
      .mockReturnValueOnce({ name: 'yeni' });
    const harness = renderWindow(managerHarness);

    let oldShow: Promise<void> | void;
    await act(async () => {
      oldShow = harness.ref.current?.OnShow();
      await Promise.resolve();
    });
    const firstControl = queryControlAt(0);
    expect(firstControl.signal?.aborted).toBe(false);

    let newShow: Promise<void> | void;
    await act(async () => {
      newShow = harness.ref.current?.OnShow();
      await Promise.resolve();
    });

    expect(firstControl.signal?.aborted).toBe(true);
    expect(queryControlAt(1).signal?.aborted).toBe(false);

    second.resolve(success([
      result(22, 'Yeni Arama Sonucu'),
    ]));
    await act(async () => {
      await newShow;
    });

    expect(await screen.findByText('Yeni Arama Sonucu')).toBeInTheDocument();

    first.resolve(success([
      result(11, 'Eski Arama Sonucu'),
    ]));
    await act(async () => {
      await oldShow;
    });

    expect(screen.queryByText('Eski Arama Sonucu')).not.toBeInTheDocument();
    expect(screen.getByText('Yeni Arama Sonucu')).toBeInTheDocument();
  });

  it('keeps the newest loading lifecycle authoritative when an older request finishes late', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.query
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const harness = renderWindow();

    let firstShow: Promise<void> | void;
    let secondShow: Promise<void> | void;
    await act(async () => {
      firstShow = harness.ref.current?.OnShow();
      await Promise.resolve();
      secondShow = harness.ref.current?.OnShow();
      await Promise.resolve();
    });

    first.resolve(success([result(1, 'Eski')]));
    await act(async () => {
      await firstShow;
    });

    expect(screen.getByText('Aranıyor…')).toBeInTheDocument();

    second.resolve(success([result(2, 'Yeni')]));
    await act(async () => {
      await secondShow;
    });

    expect(screen.queryByText('Aranıyor…')).not.toBeInTheDocument();
    expect(screen.getByText('Yeni')).toBeInTheDocument();
  });

  it('aborts an active search when the managed window closes', async () => {
    const pending = deferred<unknown>();
    mocks.query.mockImplementationOnce(() => pending.promise);
    const harness = renderWindow();

    let showPromise: Promise<void> | void;
    await act(async () => {
      showPromise = harness.ref.current?.OnShow();
      await Promise.resolve();
    });

    const control = queryControlAt(0);
    expect(control.signal?.aborted).toBe(false);

    act(() => {
      harness.ref.current?.OnClose();
    });
    expect(control.signal?.aborted).toBe(true);

    pending.resolve(success([result(1, 'Geç Sonuç')]));
    await act(async () => {
      await showPromise;
    });

    expect(screen.queryByText('Geç Sonuç')).not.toBeInTheDocument();
    expect(screen.queryByText('Aranıyor…')).not.toBeInTheDocument();
  });

  it('aborts owned search work on component unmount and unregisters the managed window', async () => {
    const pending = deferred<unknown>();
    mocks.query.mockImplementationOnce(() => pending.promise);
    const harness = renderWindow();

    let showPromise: Promise<void> | void;
    await act(async () => {
      showPromise = harness.ref.current?.OnShow();
      await Promise.resolve();
    });
    const control = queryControlAt(0);

    act(() => {
      harness.unmount();
    });

    expect(control.signal?.aborted).toBe(true);
    expect(harness.managerHarness.UnregisterWindow).toHaveBeenCalledWith(
      'general-search-test',
      expect.anything(),
    );

    pending.resolve(success([result(1, 'Unmount Sonrası')]));
    await act(async () => {
      await showPromise;
    });
  });

  it('executes detail lookup in its own transport lane with geometry enabled', async () => {
    mocks.query.mockImplementation((
      query: FastAccessQuery,
      returnGeometry: boolean,
    ) => {
      if (!returnGeometry) {
        return success([
          result(42, 'Ankara Kalesi', 'Altındağ'),
        ]);
      }
      return success([
        {
          ObjectId: query.ObjectId,
          Title: 'Ankara Kalesi',
          geometry: Object.freeze({
            latitude: 39.938,
            longitude: 32.864,
          }),
        },
      ]);
    });
    const harness = renderWindow();

    await runOnShow(harness.ref);
    const resultButton = await screen.findByRole('button', {
      name: 'Ankara Kalesi kaydını haritada göster',
    });

    await act(async () => {
      fireEvent.click(resultButton);
      await waitFor(() => {
        expect(mocks.query).toHaveBeenCalledTimes(2);
      });
    });

    const [detailQuery, returnGeometry] = mocks.query.mock.calls[1] ?? [];
    expect(detailQuery).toMatchObject({ ObjectId: 42 });
    expect(returnGeometry).toBe(true);

    const control = queryControlAt(1);
    expect(control.timeoutMs).toBe(15_000);
    expect(control.cacheTtlMs).toBe(30_000);
    expect(control.deduplicate).toBe(false);
    expect(control.requestKey).toContain('genel-arama-v11:detail');

    await waitFor(() => {
      expect(mocks.zoomToGeometry).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'map-view' }),
        expect.objectContaining({
          latitude: 39.938,
          longitude: 32.864,
        }),
        18,
      );
    });
  });

  it('supersedes an older detail lookup without surfacing a false missing-location error', async () => {
    const firstDetail = deferred<unknown>();
    const secondDetail = deferred<unknown>();
    let detailCalls = 0;

    mocks.query.mockImplementation((
      query: FastAccessQuery,
      returnGeometry: boolean,
    ) => {
      if (!returnGeometry) {
        return success([
          result(1, 'Birinci'),
          result(2, 'İkinci'),
        ]);
      }
      detailCalls += 1;
      return detailCalls === 1 ? firstDetail.promise : secondDetail.promise;
    });

    const harness = renderWindow();
    await runOnShow(harness.ref);

    const firstButton = await screen.findByRole('button', {
      name: 'Birinci kaydını haritada göster',
    });
    const secondButton = screen.getByRole('button', {
      name: 'İkinci kaydını haritada göster',
    });

    act(() => {
      fireEvent.click(firstButton);
    });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
    const firstDetailControl = queryControlAt(1);

    act(() => {
      fireEvent.click(secondButton);
    });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(3));

    expect(firstDetailControl.signal?.aborted).toBe(true);

    secondDetail.resolve(success([
      {
        ObjectId: 2,
        geometry: { latitude: 39.9, longitude: 32.8 },
      },
    ]));
    await waitFor(() => expect(mocks.zoomToGeometry).toHaveBeenCalledTimes(1));

    firstDetail.resolve(success([
      {
        ObjectId: 1,
        geometry: { latitude: 40, longitude: 33 },
      },
    ]));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.zoomToGeometry).toHaveBeenCalledTimes(1);
    expect(harness.managerHarness.ShowMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('konumu bulunamadı'),
    );
  });

  it('shows a bounded service-declared failure through the existing error surface', async () => {
    mocks.query.mockResolvedValue(failure('Servis geçici olarak kullanılamıyor.'));
    const harness = renderWindow();

    await runOnShow(harness.ref);

    expect(await screen.findByText('Arama tamamlanamadı.')).toBeInTheDocument();
    expect(screen.getByText('Servis geçici olarak kullanılamıyor.')).toBeInTheDocument();
    expect(harness.managerHarness.ShowMessage).toHaveBeenCalledWith(
      expect.anything(),
      'Servis geçici olarak kullanılamıyor.',
    );
  });

  it('does not render malformed successful payloads as an empty successful search', async () => {
    mocks.query.mockResolvedValue({
      type: 10,
      data: { not: 'an array' },
    });
    const harness = renderWindow();

    await runOnShow(harness.ref);

    expect(await screen.findByText('Arama tamamlanamadı.')).toBeInTheDocument();
    expect(screen.queryByText('Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin.'))
      .not.toBeInTheDocument();
    expect(harness.managerHarness.ShowMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing client logging path without coupling logging failure to transport success', async () => {
    mocks.createClientLog.mockRejectedValueOnce(new Error('logging unavailable'));
    mocks.query.mockResolvedValue(success([result(7, 'Logdan Bağımsız')]));
    const harness = renderWindow();

    await runOnShow(harness.ref);

    expect(mocks.createClientLog).toHaveBeenCalledWith(
      'Genel Arama/Sorgu',
      expect.objectContaining({ name: 'park' }),
    );
    expect(await screen.findByText('Logdan Bağımsız')).toBeInTheDocument();
    expect(harness.managerHarness.ShowMessage).not.toHaveBeenCalled();
  });

  it('keeps query and detail request keys operation-scoped for the same managed window', async () => {
    mocks.query.mockImplementation((
      query: FastAccessQuery,
      returnGeometry: boolean,
    ) => returnGeometry
      ? success([{ ObjectId: query.ObjectId, geometry: { latitude: 39, longitude: 32 } }])
      : success([result(5, 'Aynı Pencere')]));
    const harness = renderWindow();

    await runOnShow(harness.ref);
    fireEvent.click(await screen.findByRole('button', {
      name: 'Aynı Pencere kaydını haritada göster',
    }));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));

    const searchKey = queryControlAt(0).requestKey;
    const detailKey = queryControlAt(1).requestKey;
    expect(searchKey).toContain(':search:');
    expect(detailKey).toContain(':detail:');
    expect(searchKey).not.toBe(detailKey);
  });
});
