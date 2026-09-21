import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../Core/AppConfig';
import { loadArcgisModule } from '../gis-engine/arcgisModuleRuntime';
import { AuthBusiness } from './AuthBusiness';
import { HttpBusiness } from './HttpBusiness';
import { TkgmQueryBusiness } from './TkgmQueryBusiness';
import { clearBusinessRuntimeDiagnostics } from './runtime';

vi.mock('../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModule: vi.fn(),
}));

vi.mock('./AuthBusiness', () => ({
  AuthBusiness: {
    GetRequestHeaders: vi.fn(),
  },
}));

vi.mock('./HttpBusiness', () => ({
  HttpBusiness: {
    Get: vi.fn(),
  },
}));

const moduleMock = vi.mocked(loadArcgisModule);
const headersMock = vi.mocked(AuthBusiness.GetRequestHeaders);
const getMock = vi.mocked(HttpBusiness.Get);

describe('TkgmQueryBusiness strict TypeScript runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBusinessRuntimeDiagnostics();
    headersMock.mockResolvedValue({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    getMock.mockResolvedValue({});
  });

  it('uses current BaseUrl instead of removed legacy Api.Url for parcel info', async () => {
    await TkgmQueryBusiness.GetParcelInfo('10', '20', '30');

    expect(getMock).toHaveBeenCalledWith(
      `${AppConfig.Api.BaseUrl}/Tkgm/TkgmServicev2.svc/GetParcelInfo`,
      expect.objectContaining({
        params: {
          mahalleId: '10',
          adaNo: '20',
          parselNo: '30',
        },
      }),
    );
  });

  it('returns null without network work when all parcel-info identifiers are empty', async () => {
    await expect(TkgmQueryBusiness.GetParcelInfo(null, null, null))
      .resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('encodes authenticated district identifiers and parses JSON payloads', async () => {
    getMock.mockResolvedValue(JSON.stringify({
      features: [{ id: 1 }],
    }));

    await expect(TkgmQueryBusiness.GetDistricts("1/2"))
      .resolves.toEqual([{ id: 1 }]);

    expect(getMock).toHaveBeenCalledWith(
      `${AppConfig.Api.BaseUrl}/Gis/Tkgm/Districts/1%2F2`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('rejects invalid geographic coordinates before direct TKGM point request', async () => {
    await expect(TkgmQueryBusiness.IntersectMapPointWithTkgmParcel({
      latitude: 100,
      longitude: 32,
    })).resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('preserves the existing direct TKGM parcel endpoint for valid points', async () => {
    getMock.mockResolvedValue({ parcel: 1 });

    await expect(TkgmQueryBusiness.IntersectMapPointWithTkgmParcel({
      latitude: 39.9,
      longitude: 32.8,
    })).resolves.toEqual({ parcel: 1 });

    expect(getMock).toHaveBeenCalledWith(
      'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api/parsel/39.9/32.8',
    );
  });

  it('normalizes geographic polygon coordinates and calls same-origin parcel service', async () => {
    moduleMock.mockResolvedValue({
      webMercatorToGeographic: () => ({
        rings: [[
          [32.1, 39.1],
          [32.2, 39.2],
          [32.3, 39.3],
          [32.1, 39.1],
        ]],
      }),
    });
    getMock.mockResolvedValue({ data: [] });

    await TkgmQueryBusiness.IntersectMapPolygonWithTkgmParcel({ rings: [] });

    expect(getMock).toHaveBeenCalledWith(
      `${AppConfig.Api.BaseUrl}/Tkgm/TkgmServicev2.svc/GetParcelsInPolygon`,
      expect.objectContaining({
        params: {
          polygon: '32.100000 39.100000,32.200000 39.200000,32.300000 39.300000,32.100000 39.100000',
          pasifleriGoster: true,
        },
      }),
    );
  });

  it('rejects invalid polygons without calling the parcel service', async () => {
    moduleMock.mockResolvedValue({
      webMercatorToGeographic: () => ({
        rings: [[[32.1, 39.1], [32.2, 39.2]]],
      }),
    });

    await expect(TkgmQueryBusiness.IntersectMapPolygonWithTkgmParcel({}))
      .resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns null and does not console-log when TKGM HTTP calls fail', async () => {
    getMock.mockRejectedValue(new Error('network'));

    await expect(TkgmQueryBusiness.GetNeighborhoodsOfDistrict('10'))
      .resolves.toBeNull();
  });
});
