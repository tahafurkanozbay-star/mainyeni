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
  it('restricts the overview layer to the selected icon key', () => {
    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('parklar')");
  });

  it('supports institution categories with more than one registered icon key and de-duplicates keys', () => {
    setKentRehberiMapFilter({ label: 'EGO', iconKeys: ['otobus', 'metro', 'otobus', 'bad key'] });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('otobus', 'metro')");
  });

  it('hides all records rather than leaking all points when an active selection has no valid keys', () => {
    setKentRehberiMapFilter({ label: 'Bilinmeyen hizmet', iconKeys: [] });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot())).toBe('1 = 2');
  });

  it('rejects malformed keys before generating a SQL expression', () => {
    setKentRehberiMapFilter({
      label: 'Unsafe input',
      iconKeys: ['parklar', "parklar'); DROP TABLE poi; --", ' spaces are not keys '],
    });
    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('parklar')");
  });

  it('restores all records when the selection is cleared and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKentRehberiMapFilter(listener);

    setKentRehberiMapFilter({ label: 'ASKİ', iconKeys: ['askibaraj'] });
    setKentRehberiMapFilter(null);

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot())).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not publish a new revision when the semantic filter is unchanged', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKentRehberiMapFilter(listener);

    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });
    const revision = getKentRehberiMapFilterSnapshot().revision;
    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });

    expect(getKentRehberiMapFilterSnapshot().revision).toBe(revision);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
