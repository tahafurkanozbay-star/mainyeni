import { IsNull } from './ObjectHelper';

const asDate = (value: string | number | Date): Date => value instanceof Date ? value : new Date(value);
const differenceMs = (end: Date | number, begin: Date | number): number =>
  (end instanceof Date ? end.getTime() : end) - (begin instanceof Date ? begin.getTime() : begin);
const numericPart = (items: readonly string[], index: number, fallback: number): number => {
  if (index < 0) return fallback;
  const raw = items[index];
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const DatetimeHelper = Object.freeze({
  ConvertFromEsriDate: (esridate: string | number | Date | null | undefined): string | null => {
    if (IsNull(esridate)) return null;
    const date = asDate(esridate as string | number | Date);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
  },

  StringToDateTime: (text: string, format: string): Date => {
    const normalized = String(text ?? '').replace(/[^a-zA-Z0-9]/gu, '-');
    const normalizedFormat = String(format ?? '').toLowerCase().replace(/[^a-zA-Z0-9]/gu, '-');
    const formatItems = normalizedFormat.split('-');
    const dateItems = normalized.split('-');
    const today = new Date();

    const year = numericPart(dateItems, formatItems.indexOf('yyyy'), today.getFullYear());
    // Preserve historical fallback semantics: absent month meant previous month.
    const month = numericPart(dateItems, formatItems.indexOf('mm'), today.getMonth()) - 1;
    const day = numericPart(dateItems, formatItems.indexOf('dd'), today.getDate());
    const hour = numericPart(dateItems, formatItems.indexOf('hh'), today.getHours());
    const minute = numericPart(dateItems, formatItems.indexOf('ii'), today.getMinutes());
    const second = numericPart(dateItems, formatItems.indexOf('ss'), today.getSeconds());

    return new Date(year, month, day, hour, minute, second);
  },

  diffMilliSeconds: (end: Date | number, begin: Date | number): number => differenceMs(end, begin),
  diffDays: (end: Date | number, begin: Date | number): number => Math.floor(differenceMs(end, begin) / 86400000),
  diffHrs: (end: Date | number, begin: Date | number): number =>
    Math.floor((differenceMs(end, begin) % 86400000) / 3600000),
  diffMins: (end: Date | number, begin: Date | number): number =>
    Math.round(((differenceMs(end, begin) % 86400000) % 3600000) / 60000),

  GetFormatted: (date: Date, showTime = true): string => {
    const dateString = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    if (!showTime) return dateString;
    return `${dateString} - ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },
});
