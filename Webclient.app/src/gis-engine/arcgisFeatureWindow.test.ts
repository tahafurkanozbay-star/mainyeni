import { describe, expect, it, vi } from 'vitest';
import { readArcgisFeatureWindow } from './arcgisFeatureWindow';

describe('readArcgisFeatureWindow', () => {
  it('deduplicates stable identities and completes on server evidence', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ features: [{ id: 0 }, { id: 1 }], exceededTransferLimit: true, nextOffset: 2 })
      .mockResolvedValueOnce({ features: [{ id: 1 }, { id: 2 }], exceededTransferLimit: false });
    const result = await readArcgisFeatureWindow({ pageSize: 2, maxFeatures: 10, maxPages: 5, identity: item => item.id, fetchPage }, new AbortController().signal);
    expect(result.features).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(result.duplicateCount).toBe(1);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('fails closed when pagination cannot make progress', async () => {
    await expect(readArcgisFeatureWindow({
      pageSize: 10,
      maxFeatures: 100,
      maxPages: 5,
      identity: (item: { id: number }) => item.id,
      fetchPage: async () => ({ features: [], exceededTransferLimit: true, nextOffset: 0 }),
    }, new AbortController().signal)).rejects.toThrow('forward progress');
  });

  it('honors feature and page budgets', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({
      features: [{ id: offset }, { id: offset + 1 }],
      exceededTransferLimit: true,
      nextOffset: offset + 2,
    }));
    const result = await readArcgisFeatureWindow({ pageSize: 2, maxFeatures: 3, maxPages: 2, identity: item => item.id, fetchPage }, new AbortController().signal);
    expect(result.features).toHaveLength(3);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('rejects invalid budgets before transport work', async () => {
    const fetchPage = vi.fn();
    await expect(readArcgisFeatureWindow({ pageSize: 0, maxFeatures: 1, maxPages: 1, identity: () => 1, fetchPage }, new AbortController().signal)).rejects.toBeInstanceOf(RangeError);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('propagates cancellation before reading a page', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(readArcgisFeatureWindow({ pageSize: 1, maxFeatures: 1, maxPages: 1, identity: () => 1, fetchPage: vi.fn() }, controller.signal)).rejects.toThrow('cancelled');
  });
});
