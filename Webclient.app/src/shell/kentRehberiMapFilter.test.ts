import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildKentRehberiDefinitionExpression,
  getKentRehberiMapFilterSnapshot,
  setKentRehberiMapFilter,
  subscribeKentRehberiMapFilter,
} from './kentRehberiMapFilter';

afterEach(() => {
  setKentRehberiMapFilter(null);
  vi.restoreAllMocks();
});

describe('Kent Rehberi map category filter', () => {
  it('filters the overview layer to only the selected icon keys', () => {
    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('parklar')");
  });

  it('supports institution categories with several distinct registered icon keys', () => {
    setKentRehberiMapFilter({ label: 'EGO', iconKeys: ['otobus', 'metro', 'otobus', 'bad key'] });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('otobus', 'metro')");
  });

  it('hides all records instead of showing all points for a category with no valid keys', () => {
    setKentRehberiMapFilter({ label: 'Bilinmeyen hizmet', iconKeys: [] });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot())).toBe('1 = 2');
  });

  it('rejects unsafe icon keys before generating a SQL expression', () => {
    setKentRehberiMapFilter({
      label: 'Unsafe input',
      iconKeys: ['parklar', "parklar'); DROP TABLE poi; --", ' spaces are not keys '],
    });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('parklar')");
  });

  it('clears the filter to restore every point and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKentRehberiMapFilter(listener);

    setKentRehberiMapFilter({ label: 'ASKİ', iconKeys: ['askibaraj'] });
    setKentRehberiMapFilter(null);

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot())).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not notify when the effective filter is unchanged', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKentRehberiMapFilter(listener);

    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });
    const revision = getKentRehberiMapFilterSnapshot().revision;
    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });

    expect(getKentRehberiMapFilterSnapshot().revision).toBe(revision);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
}
);
