const TURKISH_LOCALE = "tr-TR";

const replaceMojibake = (value: string): string => {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["Ãœ", "Ü"],
    ["Ä°", "İ"],
    ["Ã‡", "Ç"],
    ["Ã–", "Ö"],
    ["Ã¼", "ü"],
    ["ÅŸ", "ş"],
    ["ÄŸ", "ğ"],
    ["Ã§", "ç"],
    ["Ä±", "ı"],
    ["Ã¶", "ö"],
    ["Å", "Ş"],
    ["Ä", "Ğ"],
  ];
  return replacements.reduce(
    (current, [from, to]) => current.replaceAll(from, to),
    value,
  );
};

const removeTurkishChars = (value: string): string => {
  const mapping: Readonly<Record<string, string>> = Object.freeze({
    Ç: "C",
    Ö: "O",
    Ş: "S",
    İ: "I",
    Ü: "U",
    Ğ: "G",
    ç: "c",
    ö: "o",
    ş: "s",
    ı: "i",
    ü: "u",
    ğ: "g",
  });
  return [...value]
    .map((character) => mapping[character] ?? character)
    .join("")
    .replace(/[^a-z0-9-.çöşüğı\s+]/giu, "");
};

const randomHex = (): string => {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return `#${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const randomDarkHex = (): string => {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return `#${[...bytes].map((byte) => Math.floor(byte / 2).toString(16).padStart(2, "0")).join("")}`;
};

export const TextHelper = Object.freeze({
  TurkishToUpper: (text: unknown): string =>
    String(text ?? "").toLocaleUpperCase(TURKISH_LOCALE),

  TurkishToLower: (text: unknown): string =>
    String(text ?? "").toLocaleLowerCase(TURKISH_LOCALE),

  UnicodeToUtf8: (text: unknown): string =>
    replaceMojibake(String(text ?? "")),

  convertToASCII: (text: unknown): string =>
    String(text ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replaceAll("İ", "I")
      .replaceAll("ı", "i")
      .replaceAll("Ş", "S")
      .replaceAll("ş", "s")
      .replaceAll("Ğ", "G")
      .replaceAll("ğ", "g"),

  ToTurkish: (text: unknown): string =>
    String(text ?? "").toLocaleUpperCase(TURKISH_LOCALE),

  RemoveTurkishChars: (text: unknown): string =>
    removeTurkishChars(String(text ?? "")),

  CreateRandomColor: (): string => randomHex(),

  CreateRandomDarkColor: (): string => randomDarkHex(),

  CreateRandomNumber: (): number => {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return (bytes[0] ?? 0) / 1000;
  },

  CreateGuid: (): string => {
    if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  },

  ToLowerCase: (value: unknown): string =>
    String(value ?? "").toLocaleLowerCase(TURKISH_LOCALE),

  ShortenText: (text: unknown, maxlength: number): string => {
    const value = String(text ?? "");
    const max = Math.max(1, Math.trunc(maxlength));
    return value.length >= max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
  },

  SanitizeString: (value: unknown): string =>
    String(value ?? "").replace(/[^a-zA-Z0-9áéíóúñüİıÖöÜüÇçŞşĞğ\s.,_-]/gimu, ""),
});
