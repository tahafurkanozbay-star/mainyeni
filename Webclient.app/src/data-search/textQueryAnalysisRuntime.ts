import { hashFingerprint, normalizeSearchText, normalizeSearchToken, stableSerialize } from './normalization';

export type TextQueryClauseKind = 'required' | 'optional' | 'excluded' | 'phrase' | 'field';
export type TextQueryField = 'title' | 'category' | 'type' | 'district' | 'neighborhood' | 'street' | 'address' | 'postalCode' | 'any';

export interface TextQueryAnalysisPolicy {
  readonly maximumQueryLength: number;
  readonly maximumTerms: number;
  readonly maximumPhrases: number;
  readonly maximumPhraseLength: number;
  readonly maximumFieldClauses: number;
  readonly minimumPrefixLength: number;
  readonly ignoreStopWords: boolean;
}

export interface TextQueryClause {
  readonly kind: TextQueryClauseKind;
  readonly raw: string;
  readonly canonical: string;
  readonly field: TextQueryField;
  readonly ordinal: number;
}

export interface TextQueryDiagnostics {
  readonly inputLength: number;
  readonly truncated: boolean;
  readonly droppedTerms: number;
  readonly droppedPhrases: number;
  readonly droppedFieldClauses: number;
  readonly droppedStopWords: number;
  readonly malformedQuotes: boolean;
  readonly empty: boolean;
}

export interface TextQueryAnalysis {
  readonly version: 'search-query-v6';
  readonly raw: string;
  readonly boundedRaw: string;
  readonly normalized: string;
  readonly clauses: readonly TextQueryClause[];
  readonly requiredTerms: readonly string[];
  readonly optionalTerms: readonly string[];
  readonly excludedTerms: readonly string[];
  readonly phrases: readonly string[];
  readonly fieldTerms: Readonly<Record<TextQueryField, readonly string[]>>;
  readonly positiveTerms: readonly string[];
  readonly allTerms: readonly string[];
  readonly prefixEligibleTerms: readonly string[];
  readonly signature: string;
  readonly diagnostics: TextQueryDiagnostics;
}

export interface TextQueryAnalyzerSnapshot {
  readonly analyses: number;
  readonly truncatedQueries: number;
  readonly malformedQuotes: number;
  readonly droppedTerms: number;
  readonly droppedStopWords: number;
}

const DEFAULT_POLICY: TextQueryAnalysisPolicy = Object.freeze({
  maximumQueryLength: 512,
  maximumTerms: 32,
  maximumPhrases: 8,
  maximumPhraseLength: 160,
  maximumFieldClauses: 12,
  minimumPrefixLength: 2,
  ignoreStopWords: true,
});

const SEARCH_FIELDS: readonly TextQueryField[] = Object.freeze([
  'title',
  'category',
  'type',
  'district',
  'neighborhood',
  'street',
  'address',
  'postalCode',
  'any',
]);

const FIELD_ALIASES: Readonly<Record<string, TextQueryField>> = Object.freeze({
  title: 'title',
  ad: 'title',
  adi: 'title',
  name: 'title',
  category: 'category',
  kategori: 'category',
  type: 'type',
  tur: 'type',
  tip: 'type',
  district: 'district',
  ilce: 'district',
  neighborhood: 'neighborhood',
  mahalle: 'neighborhood',
  street: 'street',
  cadde: 'street',
  sokak: 'street',
  yol: 'street',
  address: 'address',
  adres: 'address',
  postal: 'postalCode',
  postcode: 'postalCode',
  zip: 'postalCode',
  posta: 'postalCode',
  any: 'any',
});

const TURKISH_STOP_WORDS = new Set<string>([
  'acaba', 'ama', 'ancak', 'aslinda', 'az', 'bazı', 'bazi', 'belki', 'ben', 'benden', 'beni', 'benim',
  'beri', 'bile', 'bir', 'biraz', 'bircok', 'birçok', 'biri', 'birkaç', 'birkac', 'biz', 'bize', 'bizi',
  'bizim', 'boyle', 'böyle', 'bu', 'buna', 'bunda', 'bundan', 'bunlar', 'bunlari', 'bunları', 'bunu',
  'cok', 'çok', 'cunku', 'çünkü', 'da', 'daha', 'de', 'defa', 'diye', 'eger', 'eğer', 'en', 'gibi',
  'hem', 'hep', 'hepsi', 'her', 'hic', 'hiç', 'icin', 'için', 'ile', 'ise', 'kez', 'ki', 'kim', 'mi',
  'mu', 'mü', 'nasil', 'nasıl', 'ne', 'neden', 'nerde', 'nerede', 'nereye', 'niye', 'o', 'olan', 'olarak',
  'oldu', 'olmak', 'olmasi', 'olması', 'olmayan', 'olmaz', 'olsa', 'olsun', 'on', 'ona', 'ondan', 'onlar',
  'onu', 'oyle', 'öyle', 'pek', 'rağmen', 'ragmen', 'sadece', 'sanki', 'sen', 'senden', 'seni', 'senin',
  'sey', 'şey', 'siz', 'size', 'sizi', 'sizin', 'sonra', 'su', 'şu', 'tüm', 'tum', 've', 'veya', 'ya',
  'yani', 'yerine', 'yine', 'yoksa', 'zaten',
]);

const normalizeBoundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`policy value must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: Partial<TextQueryAnalysisPolicy>): TextQueryAnalysisPolicy => Object.freeze({
  maximumQueryLength: normalizeBoundedInteger(input.maximumQueryLength, DEFAULT_POLICY.maximumQueryLength, 16, 4096),
  maximumTerms: normalizeBoundedInteger(input.maximumTerms, DEFAULT_POLICY.maximumTerms, 1, 256),
  maximumPhrases: normalizeBoundedInteger(input.maximumPhrases, DEFAULT_POLICY.maximumPhrases, 0, 64),
  maximumPhraseLength: normalizeBoundedInteger(input.maximumPhraseLength, DEFAULT_POLICY.maximumPhraseLength, 8, 1024),
  maximumFieldClauses: normalizeBoundedInteger(input.maximumFieldClauses, DEFAULT_POLICY.maximumFieldClauses, 0, 128),
  minimumPrefixLength: normalizeBoundedInteger(input.minimumPrefixLength, DEFAULT_POLICY.minimumPrefixLength, 1, 32),
  ignoreStopWords: input.ignoreStopWords ?? DEFAULT_POLICY.ignoreStopWords,
});

const emptyFieldTerms = (): Record<TextQueryField, string[]> => ({
  title: [],
  category: [],
  type: [],
  district: [],
  neighborhood: [],
  street: [],
  address: [],
  postalCode: [],
  any: [],
});

const freezeFieldTerms = (value: Record<TextQueryField, string[]>): Readonly<Record<TextQueryField, readonly string[]>> => Object.freeze({
  title: Object.freeze(value.title.slice()),
  category: Object.freeze(value.category.slice()),
  type: Object.freeze(value.type.slice()),
  district: Object.freeze(value.district.slice()),
  neighborhood: Object.freeze(value.neighborhood.slice()),
  street: Object.freeze(value.street.slice()),
  address: Object.freeze(value.address.slice()),
  postalCode: Object.freeze(value.postalCode.slice()),
  any: Object.freeze(value.any.slice()),
});

const unique = (values: readonly string[]): readonly string[] => Object.freeze(Array.from(new Set(values)));

const canonicalPhrase = (value: string): string => normalizeSearchText(value)
  .replace(/[^a-z0-9\s]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const isStopWord = (value: string): boolean => TURKISH_STOP_WORDS.has(value);

interface Lexeme {
  readonly raw: string;
  readonly quoted: boolean;
  readonly ordinal: number;
}

interface LexResult {
  readonly lexemes: readonly Lexeme[];
  readonly malformedQuotes: boolean;
}

const lexQuery = (value: string): LexResult => {
  const lexemes: Lexeme[] = [];
  let buffer = '';
  let quoted = false;
  let ordinal = 0;
  let escaped = false;

  const flush = (): void => {
    const raw = buffer.trim();
    buffer = '';
    if (!raw) return;
    lexemes.push(Object.freeze({ raw, quoted, ordinal }));
    ordinal += 1;
  };

  for (const character of value) {
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      if (quoted) flush();
      else flush();
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      flush();
      continue;
    }
    buffer += character;
  }
  if (escaped) buffer += '\\';
  flush();
  return Object.freeze({ lexemes: Object.freeze(lexemes), malformedQuotes: quoted });
};

const parseField = (raw: string): { readonly field: TextQueryField; readonly value: string } | null => {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon >= raw.length - 1) return null;
  const alias = normalizeSearchToken(raw.slice(0, colon));
  const field = FIELD_ALIASES[alias];
  if (!field) return null;
  return Object.freeze({ field, value: raw.slice(colon + 1) });
};

interface MutableAnalysis {
  clauses: TextQueryClause[];
  requiredTerms: string[];
  optionalTerms: string[];
  excludedTerms: string[];
  phrases: string[];
  fieldTerms: Record<TextQueryField, string[]>;
  droppedTerms: number;
  droppedPhrases: number;
  droppedFieldClauses: number;
  droppedStopWords: number;
}

const appendTerm = (
  mutable: MutableAnalysis,
  raw: string,
  canonical: string,
  kind: 'required' | 'optional' | 'excluded',
  ordinal: number,
  policy: TextQueryAnalysisPolicy,
): void => {
  const acceptedCount = mutable.requiredTerms.length + mutable.optionalTerms.length + mutable.excludedTerms.length;
  if (acceptedCount >= policy.maximumTerms) {
    mutable.droppedTerms += 1;
    return;
  }
  if (!canonical) return;
  if (policy.ignoreStopWords && kind === 'optional' && isStopWord(canonical)) {
    mutable.droppedStopWords += 1;
    return;
  }
  mutable.clauses.push(Object.freeze({ kind, raw, canonical, field: 'any', ordinal }));
  if (kind === 'required') mutable.requiredTerms.push(canonical);
  else if (kind === 'excluded') mutable.excludedTerms.push(canonical);
  else mutable.optionalTerms.push(canonical);
};

const appendPhrase = (
  mutable: MutableAnalysis,
  raw: string,
  ordinal: number,
  policy: TextQueryAnalysisPolicy,
): void => {
  if (mutable.phrases.length >= policy.maximumPhrases) {
    mutable.droppedPhrases += 1;
    return;
  }
  const bounded = raw.length > policy.maximumPhraseLength ? raw.slice(0, policy.maximumPhraseLength) : raw;
  const canonical = canonicalPhrase(bounded);
  if (!canonical) return;
  mutable.phrases.push(canonical);
  mutable.clauses.push(Object.freeze({ kind: 'phrase', raw, canonical, field: 'any', ordinal }));
};

const appendFieldClause = (
  mutable: MutableAnalysis,
  raw: string,
  field: TextQueryField,
  value: string,
  ordinal: number,
  policy: TextQueryAnalysisPolicy,
): void => {
  const fieldCount = mutable.clauses.filter((clause) => clause.kind === 'field').length;
  if (fieldCount >= policy.maximumFieldClauses) {
    mutable.droppedFieldClauses += 1;
    return;
  }
  const canonical = normalizeSearchToken(value);
  if (!canonical) return;
  mutable.fieldTerms[field].push(canonical);
  mutable.clauses.push(Object.freeze({ kind: 'field', raw, canonical, field, ordinal }));
};

const consumeLexeme = (
  mutable: MutableAnalysis,
  lexeme: Lexeme,
  policy: TextQueryAnalysisPolicy,
): void => {
  if (lexeme.quoted) {
    appendPhrase(mutable, lexeme.raw, lexeme.ordinal, policy);
    return;
  }
  const fieldClause = parseField(lexeme.raw);
  if (fieldClause) {
    appendFieldClause(mutable, lexeme.raw, fieldClause.field, fieldClause.value, lexeme.ordinal, policy);
    return;
  }
  const marker = lexeme.raw[0];
  const kind: 'required' | 'optional' | 'excluded' = marker === '+' ? 'required' : marker === '-' ? 'excluded' : 'optional';
  const value = marker === '+' || marker === '-' ? lexeme.raw.slice(1) : lexeme.raw;
  appendTerm(mutable, lexeme.raw, normalizeSearchToken(value), kind, lexeme.ordinal, policy);
};

const consumeLexemes = (lexemes: readonly Lexeme[], policy: TextQueryAnalysisPolicy): MutableAnalysis => {
  const mutable: MutableAnalysis = {
    clauses: [],
    requiredTerms: [],
    optionalTerms: [],
    excludedTerms: [],
    phrases: [],
    fieldTerms: emptyFieldTerms(),
    droppedTerms: 0,
    droppedPhrases: 0,
    droppedFieldClauses: 0,
    droppedStopWords: 0,
  };
  for (const lexeme of lexemes) consumeLexeme(mutable, lexeme, policy);
  return mutable;
};

const flattenFieldTerms = (fieldTerms: Readonly<Record<TextQueryField, readonly string[]>>): readonly string[] => {
  const values: string[] = [];
  for (const field of SEARCH_FIELDS) values.push(...fieldTerms[field]);
  return unique(values);
};

const buildSignature = (
  requiredTerms: readonly string[],
  optionalTerms: readonly string[],
  excludedTerms: readonly string[],
  phrases: readonly string[],
  fieldTerms: Readonly<Record<TextQueryField, readonly string[]>>,
): string => hashFingerprint(stableSerialize({ requiredTerms, optionalTerms, excludedTerms, phrases, fieldTerms }));

export const analyzeTextQuery = (
  input: unknown,
  policyInput: Partial<TextQueryAnalysisPolicy> = {},
): TextQueryAnalysis => {
  const policy = normalizePolicy(policyInput);
  const raw = input === null || input === undefined ? '' : String(input);
  const truncated = raw.length > policy.maximumQueryLength;
  const boundedRaw = truncated ? raw.slice(0, policy.maximumQueryLength) : raw;
  const normalized = normalizeSearchText(boundedRaw).replace(/\s+/g, ' ').trim();
  const lexed = lexQuery(boundedRaw);
  const mutable = consumeLexemes(lexed.lexemes, policy);
  const fieldTerms = freezeFieldTerms(mutable.fieldTerms);
  const requiredTerms = unique(mutable.requiredTerms);
  const optionalTerms = unique(mutable.optionalTerms);
  const excludedTerms = unique(mutable.excludedTerms);
  const phrases = unique(mutable.phrases);
  const fieldFlat = flattenFieldTerms(fieldTerms);
  const positiveTerms = unique([...requiredTerms, ...optionalTerms, ...fieldFlat]);
  const allTerms = unique([...positiveTerms, ...excludedTerms]);
  const prefixEligibleTerms = Object.freeze(positiveTerms.filter((term) => term.length >= policy.minimumPrefixLength));
  const diagnostics: TextQueryDiagnostics = Object.freeze({
    inputLength: raw.length,
    truncated,
    droppedTerms: mutable.droppedTerms,
    droppedPhrases: mutable.droppedPhrases,
    droppedFieldClauses: mutable.droppedFieldClauses,
    droppedStopWords: mutable.droppedStopWords,
    malformedQuotes: lexed.malformedQuotes,
    empty: positiveTerms.length === 0 && phrases.length === 0,
  });
  return Object.freeze({
    version: 'search-query-v6',
    raw,
    boundedRaw,
    normalized,
    clauses: Object.freeze(mutable.clauses.slice()),
    requiredTerms,
    optionalTerms,
    excludedTerms,
    phrases,
    fieldTerms,
    positiveTerms,
    allTerms,
    prefixEligibleTerms,
    signature: buildSignature(requiredTerms, optionalTerms, excludedTerms, phrases, fieldTerms),
    diagnostics,
  });
};

export class TextQueryAnalysisRuntime {
  readonly #policy: TextQueryAnalysisPolicy;
  #analyses = 0;
  #truncatedQueries = 0;
  #malformedQuotes = 0;
  #droppedTerms = 0;
  #droppedStopWords = 0;

  constructor(policy: Partial<TextQueryAnalysisPolicy> = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): TextQueryAnalysisPolicy {
    return this.#policy;
  }

  analyze(input: unknown): TextQueryAnalysis {
    const result = analyzeTextQuery(input, this.#policy);
    this.#analyses += 1;
    if (result.diagnostics.truncated) this.#truncatedQueries += 1;
    if (result.diagnostics.malformedQuotes) this.#malformedQuotes += 1;
    this.#droppedTerms += result.diagnostics.droppedTerms;
    this.#droppedStopWords += result.diagnostics.droppedStopWords;
    return result;
  }

  snapshot(): TextQueryAnalyzerSnapshot {
    return Object.freeze({
      analyses: this.#analyses,
      truncatedQueries: this.#truncatedQueries,
      malformedQuotes: this.#malformedQuotes,
      droppedTerms: this.#droppedTerms,
      droppedStopWords: this.#droppedStopWords,
    });
  }

  reset(): void {
    this.#analyses = 0;
    this.#truncatedQueries = 0;
    this.#malformedQuotes = 0;
    this.#droppedTerms = 0;
    this.#droppedStopWords = 0;
  }
}
