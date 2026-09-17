type CharacterMap = Readonly<Record<string, string>>;

const TURKISH_ASCII_MAP: CharacterMap = Object.freeze({
  Ç: 'C', Ö: 'O', Ş: 'S', İ: 'I', Ü: 'U', Ğ: 'G',
  ç: 'c', ö: 'o', ş: 's', ı: 'i', ü: 'u', ğ: 'g',
});

const randomUint32 = (): number => {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) return Math.floor(Math.random() * 0xffffffff);
  const values = new Uint32Array(1);
  cryptoApi.getRandomValues(values);
  return values[0] ?? 0;
};

export const TextHelper = Object.freeze({
  TurkishToUpper: (text: string | null | undefined): string | undefined => text
    ?.replace(/ğ/gu, 'Ğ')
    .replace(/ü/gu, 'Ü')
    .replace(/ş/gu, 'Ş')
    .replace(/ı/gu, 'I')
    .replace(/i/gu, 'İ')
    .replace(/ö/gu, 'Ö')
    .replace(/ç/gu, 'Ç')
    .toUpperCase(),

  TurkishToLower: (text: string | null | undefined): string | undefined => text
    ?.replace(/Ğ/gu, 'ğ')
    .replace(/Ü/gu, 'ü')
    .replace(/Ş/gu, 'ş')
    .replace(/I/gu, 'i')
    .replace(/İ/gu, 'i')
    .replace(/Ö/gu, 'ö')
    .replace(/Ç/gu, 'ç')
    .toLowerCase(),

  UnicodeToUtf8: (text: string): string => text
    .replace(/Ãœ/gu, 'Ü').replace(/Ä°/gu, 'İ').replace(/Ã‡/gu, 'Ç').replace(/Ã–/gu, 'Ö')
    .replace(/Ã¼/gu, 'ü').replace(/ÅŸ/gu, 'ş').replace(/ÄŸ/gu, 'ğ').replace(/Ã§/gu, 'ç')
    .replace(/Ä±/gu, 'ı').replace(/Ã¶/gu, 'ö').replace(/Å/gu, 'Ş').replace(/Ä/gu, 'Ğ'),

  convertToASCII: (text: string): string => text
    .replace(/\u00c2/gu, 'A')
    .replace(/\u00e2/gu, 'a')
    .replace(/\u00fb/gu, 'u')
    .replace(/\u0130/gu, 'I')
    .replace(/\u0131/gu, 'i')
    .replace(/\u015e/gu, 'S')
    .replace(/\u015f/gu, 's')
    .replace(/\u00dc/gu, 'U')
    .replace(/\u00fc/gu, 'u'),

  ToTurkish: (text: string): string => {
    const result: string[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const character = text.charAt(index);
      if (code === 105) result.push('İ');
      else if (code === 305) result.push('I');
      else if (code === 287) result.push('Ğ');
      else if (code === 252) result.push('Ü');
      else if (code === 351) result.push('Ş');
      else if (code === 246) result.push('Ö');
      else if (code === 231) result.push('Ç');
      else if (code >= 97 && code <= 122) result.push(character.toUpperCase());
      else result.push(character);
    }
    return result.join('');
  },

  RemoveTurkishChars: (text: unknown): string => String(text ?? '')
    .split('')
    .map((character) => TURKISH_ASCII_MAP[character] ?? character)
    .join('')
    .replace(/[^a-z0-9-.çöşüğı\s+]/giu, ''),

  CreateRandomColor: (): string => `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`,

  CreateRandomDarkColor: (): string => {
    let color = '#';
    for (let index = 0; index < 6; index += 1) color += Math.floor(Math.random() * 10);
    return color;
  },

  CreateRandomNumber: (): number => randomUint32() / 1000,

  CreateGuid: (): string => {
    const s4 = (): string => Math.floor((1 + randomUint32() / 0xffffffff) * 0x10000)
      .toString(16)
      .substring(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
  },

  ToLowerCase: (obj: string): string => obj.toLowerCase().replace('İ', 'i'),

  ShortenText: (text: string | null | undefined, maxlength: number): string | null | undefined => {
    if (!text) return text;
    const maximum = Math.max(1, Math.trunc(maxlength));
    return text.length >= maximum ? `${text.slice(0, maximum - 1)}&hellip;` : text;
  },

  SanitizeString: (str: string): string => str.replace(/[^a-zA-Z0-9áéíóúñüİıÖöÜüÇçŞşĞğ\s.,_-]/gimu, ''),
});
