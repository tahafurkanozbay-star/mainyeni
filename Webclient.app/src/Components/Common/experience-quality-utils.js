const TURKISH_REPLACEMENTS = Object.freeze({
  'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
  'Ç': 'c', 'Ğ': 'g', 'İ': 'i', 'I': 'i', 'Ö': 'o', 'Ş': 's', 'Ü': 'u',
});

export const normalizeCommandQuery = (value = '') => String(value)
  .split('')
  .map((character) => TURKISH_REPLACEMENTS[character] || character)
  .join('')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase('tr-TR');

export const buildCommandQueryKey = (value) => normalizeCommandQuery(value);
