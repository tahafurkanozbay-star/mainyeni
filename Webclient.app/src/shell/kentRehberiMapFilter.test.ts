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
  it('restricts the overview layer to only the selected SVG category', () => {
    setKentRehberiMapFilter({ label: 'Otobüs Durakları', iconKeys: ['otobus'] });

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('otobus')");
  });

  it('supports institution categories with more than one registered icon key', () => {
    setKentRehberiMapFilter({ label: 'EGO', iconKeys: ['otobus', 'metro', 'otobus', 'bad key'] });

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('otobus', 'metro')");
  });

  it('never falls back to showing all points if an active selection resolves to no icons', () => {
    setKentRehberiMapFilter({ label: 'Bilinmeyen hizmet', iconKeys: [] });

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot())).toBe('1 = 2');
  });

  it('rejects malformed keys before generating a SQL expression', () => {
    setKentRehberiMapFilter({
      label: 'Unsafe test input',
      iconKeys: ['parklar', "parklar'); DROP TABLE poi; --", ' spaces are not keys '],
    });

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot()))
      .toBe("iconKey IN ('parklar')");
  });

  it('restores all markers when the selection is cleared and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKentRehberiMapFilter(listener);

    setKentRehberiMapFilter({ label: 'ASKİ', iconKeys: ['askibaraj'] });
    setKentRehberiMapFilter(null);

    expect(buildKentRehberiDefinitionExpression(getKentRehberiMapFilterSnapshot())).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not notify or revise the snapshot when the semantic filter is unchanged', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKentRehberiMapFilter(listener);

    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });
    const revision = getKentRehberiMapFilterSnapshot().revision;
    setKentRehberiMapFilter({ label: 'Parklar', iconKeys: ['parklar'] });

    expect(getKentRehberiMapFilterSnapshot().revision).toBe(revision);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
