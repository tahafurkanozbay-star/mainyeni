import { IsNull } from './ObjectHelper';
import { TextHelper } from './TextHelper';

type PropertyKeyOf<TValue> = Extract<keyof TValue, string>;
type Grouped<TValue> = Record<string, TValue[]>;

const serialiseDistinct = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const ArrayHelper = Object.freeze({
  Filter: <TValue extends Record<string, unknown>>(
    array: readonly TValue[] | null | undefined,
    prop: PropertyKeyOf<TValue>,
    value: unknown,
  ): TValue[] => {
    const foundArray: TValue[] = [];
    if (!Array.isArray(array)) return foundArray;
    for (let index = 0; index < array.length; index += 1) {
      const item = array[index];
      if (!item || item[prop] !== value) continue;
      (item as TValue & { _INDEX?: number })._INDEX = index;
      foundArray.push(item);
    }
    return foundArray;
  },

  Find: <TValue extends Record<string, unknown>>(
    array: readonly TValue[] | null | undefined,
    prop: PropertyKeyOf<TValue>,
    value: unknown,
  ): TValue | null => {
    const matches = ArrayHelper.Filter(array, prop, value);
    return matches[0] ?? null;
  },

  OrderByTurkish: <TValue extends Record<string, unknown>>(
    left: TValue,
    right: TValue,
    field: PropertyKeyOf<TValue>,
  ): number => {
    let targetField = field;
    if (IsNull(left[targetField])) {
      const upper = TextHelper.TurkishToUpper(String(targetField));
      if (upper && upper in left) targetField = upper as PropertyKeyOf<TValue>;
    }
    const leftTitle = String(left[targetField] ?? '');
    const rightTitle = String(right[targetField] ?? '');
    const alphabet = '0123456789AaBbCcÇçDdEeFfGgĞğHhIıİiJjKkLlMmNnOoÖöPpQqRrSsŞşTtUuÜüVvWwXxYyZz';
    if (leftTitle.length === 0 || rightTitle.length === 0) return leftTitle.length - rightTitle.length;
    for (let index = 0; index < leftTitle.length && index < rightTitle.length; index += 1) {
      const leftIndex = alphabet.indexOf(leftTitle[index]?.toUpperCase() ?? '');
      const rightIndex = alphabet.indexOf(rightTitle[index]?.toUpperCase() ?? '');
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    }
    return leftTitle.length - rightTitle.length;
  },

  GroupBy: <TValue extends Record<string, unknown>>(
    array: readonly TValue[],
    key: string,
    hasAttr = false,
  ): Grouped<TValue> => array.reduce<Grouped<TValue>>((result, item) => {
    const container = hasAttr && item.attr && typeof item.attr === 'object'
      ? item.attr as Record<string, unknown>
      : item;
    const raw = container[key];
    const groupKey = String(raw ?? '');
    (result[groupKey] ??= []).push(item);
    return result;
  }, {}),

  GroupByCount: <TValue extends Record<string, unknown>>(
    array: readonly TValue[],
    key: string,
  ): Array<{ key: string; count: number }> => {
    const counts: Record<string, number> = {};
    array.forEach((item) => {
      const groupKey = String(item[key] ?? '');
      counts[groupKey] = (counts[groupKey] ?? 0) + 1;
    });
    return Object.entries(counts).map(([groupKey, count]) => ({ key: groupKey, count }));
  },

  Distinct: <TValue>(array: readonly TValue[]): TValue[] => {
    const seen = new Set<string>();
    const result: TValue[] = [];
    for (const value of array) {
      const serialized = serialiseDistinct(value);
      if (seen.has(serialized)) continue;
      seen.add(serialized);
      result.push(value);
    }
    return result;
  },
});
