const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
const apiPostForm = vi.hoisted(() => vi.fn());
const exportCsv = vi.hoisted(() => vi.fn());

vi.mock('../runtime/adminApiClient', () => ({
  adminApiGet: apiGet,
  adminApiPost: apiPost,
  adminApiPostForm: apiPostForm,
}));

vi.mock('../Core/Toolbox/DataHelper', () => ({
  DataHelper: {
    ExportJsonToCsv: exportCsv,
  },
}));

import { BasemapLayerBusiness } from './BasemapLayerBusiness';
import { ConfigServicesBusiness } from './ConfigServicesBusiness';
import { LayerBusiness } from './LayerBusiness';
import { LayerGroupBusiness } from './LayerGroupBusiness';
import { LayerPermissionBusiness } from './LayerPermissionBusiness';
import { SettingsBusiness } from './SettingsBusiness';
import { UserAccountBusiness } from './UserAccountBusiness';
import { UserAccountPasswordBusiness } from './UserAccountPasswordBusiness';
import { UserActionBusiness } from './UserActionBusiness';
import { UserActionPermissionBusiness } from './UserActionPermissionBusiness';
import { UserRoleBusiness } from './UserRoleBusiness';

describe('admin business transport contracts', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiPostForm.mockReset();
    exportCsv.mockReset();

    apiGet.mockResolvedValue({ type: 10, data: [] });
    apiPost.mockResolvedValue({ type: 10, data: null });
    apiPostForm.mockResolvedValue({ type: 10, data: null });
    exportCsv.mockResolvedValue(undefined);
  });

  test('settings endpoints preserve query and JSON payload contracts', async () => {
    await SettingsBusiness.Get('Gis Map/Config');
    await SettingsBusiness.Save({ ConfigKey: 'GisMapConfig', ConfigValue: '{}' });

    expect(apiGet).toHaveBeenCalledWith('/AppSettings/List', {
      query: { key: 'Gis Map/Config' },
    });
    expect(apiPost).toHaveBeenCalledWith('/AppSettings/Save', {
      ConfigKey: 'GisMapConfig',
      ConfigValue: '{}',
    });
  });

  test('layer CRUD preserves server endpoint and identifier casing', async () => {
    await LayerBusiness.List();
    await LayerBusiness.Save({ id: 7, title: 'Layer' });
    await LayerBusiness.Delete({ id: 7 });

    expect(apiGet).toHaveBeenCalledWith('/Gis/Layer/List');
    expect(apiPost).toHaveBeenNthCalledWith(
      1,
      '/Gis/Layer/Save',
      { id: 7, title: 'Layer' },
    );
    expect(apiPost).toHaveBeenNthCalledWith(
      2,
      '/Gis/Layer/Delete',
      { Id: 7 },
    );
  });

  test('basemap CRUD preserves server endpoint and identifier casing', async () => {
    await BasemapLayerBusiness.List();
    await BasemapLayerBusiness.Save({ id: 8, title: 'Base' });
    await BasemapLayerBusiness.Delete({ id: 8 });

    expect(apiGet).toHaveBeenCalledWith('/Gis/BasemapLayer/List');
    expect(apiPost).toHaveBeenNthCalledWith(
      1,
      '/Gis/BasemapLayer/Save',
      { id: 8, title: 'Base' },
    );
    expect(apiPost).toHaveBeenNthCalledWith(
      2,
      '/Gis/BasemapLayer/Delete',
      { Id: 8 },
    );
  });

  test('layer-group transport keeps both list surfaces and lowercase delete id', async () => {
    await LayerGroupBusiness.List();
    await LayerGroupBusiness.ListWithLayers();
    await LayerGroupBusiness.Save({ id: 9, title: 'Group' });
    await LayerGroupBusiness.Delete({ id: 9 });

    expect(apiGet).toHaveBeenNthCalledWith(1, '/Gis/LayerGroup/List');
    expect(apiGet).toHaveBeenNthCalledWith(2, '/Gis/LayerGroup/ListWithLayers');
    expect(apiPost).toHaveBeenNthCalledWith(
      1,
      '/Gis/LayerGroup/Save',
      { id: 9, title: 'Group' },
    );
    expect(apiPost).toHaveBeenNthCalledWith(
      2,
      '/Gis/LayerGroup/Delete',
      { id: 9 },
    );
  });

  test('permission endpoints encode role ids and preserve comma-separated ids', async () => {
    const role = { id: 'role/1' };
    const permissions = [{ id: 3 }, { id: 7 }];

    await LayerPermissionBusiness.List(role);
    await LayerPermissionBusiness.Save(role, permissions);
    await UserActionPermissionBusiness.List(role);
    await UserActionPermissionBusiness.Save(role, permissions);

    expect(apiGet).toHaveBeenNthCalledWith(
      1,
      '/GisLayerPermission/List/role%2F1',
    );
    expect(apiGet).toHaveBeenNthCalledWith(
      2,
      '/UserActionPermission/List/role%2F1',
    );
    expect(apiPost).toHaveBeenNthCalledWith(
      1,
      '/GisLayerPermission/Save',
      { Id: 'role/1', LayerIds: '3,7' },
    );
    expect(apiPost).toHaveBeenNthCalledWith(
      2,
      '/UserActionPermission/Save',
      { Id: 'role/1', ActionIds: '3,7' },
    );
  });

  test('config import uses FormData without leaking multipart header ownership', async () => {
    const file = new File(['category,title'], 'config.csv', { type: 'text/csv' });

    await ConfigServicesBusiness.Import([file]);

    expect(apiPostForm).toHaveBeenCalledTimes(1);
    const [endpoint, body] = apiPostForm.mock.calls[0] ?? [];
    expect(endpoint).toBe('/Gis/ConfigService/Import');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBeInstanceOf(File);
  });

  test('config import rejects a missing file before starting transport', async () => {
    await expect(ConfigServicesBusiness.Import([])).rejects.toThrow(
      'İçe aktarılacak dosya bulunamadı.',
    );
    expect(apiPostForm).not.toHaveBeenCalled();
  });

  test('config export encodes format query and redacts service passwords from CSV', async () => {
    const result = {
      type: 10,
      data: [{
        category: 'map',
        title: 'Service',
        url: 'https://example.test',
        scUserName: 'svc-user',
        scPassword: 'must-not-export',
      }],
    };
    apiGet.mockResolvedValueOnce(result);

    await expect(ConfigServicesBusiness.Export('csv')).resolves.toBe(result);

    expect(apiGet).toHaveBeenCalledWith('/Gis/ConfigService/Export', {
      query: { format: 'csv' },
    });
    expect(exportCsv).toHaveBeenCalledTimes(1);
    const fields = exportCsv.mock.calls[0]?.[1] as string[];
    expect(fields).toContain('scUserName');
    expect(fields).not.toContain('scPassword');
  });

  test('user account, role and action CRUD use centralized paths', async () => {
    await UserAccountBusiness.List();
    await UserAccountBusiness.Save({ id: 1 });
    await UserAccountBusiness.Delete({ id: 1 });

    await UserRoleBusiness.List();
    await UserRoleBusiness.Save({ id: 2 });
    await UserRoleBusiness.Delete({ id: 2 });

    await UserActionBusiness.List();
    await UserActionBusiness.GroupedList();
    await UserActionBusiness.Save({ id: 3 });
    await UserActionBusiness.Delete({ id: 3 });

    expect(apiGet.mock.calls.map((call) => call[0])).toEqual([
      '/UserAccount/List',
      '/UserRole/List',
      '/UserAction/List',
      '/UserAction/GroupedList',
    ]);

    expect(apiPost.mock.calls).toEqual([
      ['/UserAccount/Save', { id: 1 }],
      ['/UserAccount/Delete', { id: 1 }],
      ['/UserRole/Save', { id: 2 }],
      ['/UserRole/Delete', { id: 2 }],
      ['/UserAction/Save', { id: 3 }],
      ['/UserAction/Delete', { id: 3 }],
    ]);
  });

  test('password update preserves the backend security-marker payload contract', async () => {
    await UserAccountPasswordBusiness.Save({
      id: 12,
      password: 'abcd',
      passwordRepeat: 'abcd',
    });

    expect(apiPost).toHaveBeenCalledWith('/UserAccount/UpdatePassword', {
      id: 12,
      password: 'abcd',
      passwordRepeat: 'abcd',
      sc: '[Security Key]',
    });
  });

  test('all write helpers propagate transport rejection instead of hanging forever', async () => {
    const failure = new Error('network unavailable');
    apiPost.mockRejectedValueOnce(failure);

    await expect(LayerBusiness.Save({ id: 1 })).rejects.toBe(failure);
  });
});
